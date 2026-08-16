import { AppError, errors } from '../../lib/http-errors.js';

/**
 * 一键更换 sub2api 代理 IP：
 * 解析粘贴文本（ip:port:user:pass）→ 创建新代理（名字纯数字续接自增）→
 * 把绑定在旧代理上的远端账号洗牌均分改绑到新代理 → 批量删除旧代理。
 * 上游删除接口对仍绑定账号的代理自动跳过，因此改绑失败的账号不会丢代理。
 */

const PROXY_PROTOCOLS = ['http', 'https', 'socks5', 'socks5h'];

export function proxyIdentity({ host, port, username, password }) {
  return `${String(host || '').toLowerCase()}|${Number(port)}|${String(username || '')}|${String(password || '')}`;
}

/** 解析整段粘贴文本：ip:端口:用户名:密码（或 ip:端口），兼容完整 URL 行；返回可用行 / 非法行 / 输入内重复数。 */
export function parseReplaceLines(text) {
  const items = [];
  const invalidLines = [];
  const seen = new Set();
  let duplicates = 0;

  String(text || '')
    .split(/\r?\n/)
    .forEach((raw, index) => {
      const line = index + 1;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const parsed = parseProxyLine(trimmed);
      if (!parsed) {
        invalidLines.push({ line, reason: '格式应为 ip:端口:用户名:密码（或 ip:端口）' });
        return;
      }
      const identity = proxyIdentity(parsed);
      if (seen.has(identity)) {
        duplicates += 1;
        return;
      }
      seen.add(identity);
      items.push(parsed);
    });

  return { items, invalid_lines: invalidLines, duplicates_in_input: duplicates };
}

function parseProxyLine(value) {
  // 完整 URL（或 user:pass@host:port）形式：借 URL 解析器拆字段
  if (value.includes('://') || value.includes('@')) {
    try {
      const url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`);
      const port = url.port ? Number(url.port) : null;
      if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
      return {
        host: url.hostname,
        port,
        username: url.username ? decodeURIComponent(url.username) : null,
        password: url.password ? decodeURIComponent(url.password) : null,
      };
    } catch {
      return null;
    }
  }

  const parts = value.split(':').map((part) => part.trim());
  if (parts.length !== 2 && parts.length !== 4) return null;
  const [host, portRaw, username, password] = parts;
  const port = Number(portRaw);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (parts.length === 4 && (!username || !password)) return null;
  return {
    host,
    port,
    username: parts.length === 4 ? username : null,
    password: parts.length === 4 ? password : null,
  };
}

/** 现有代理名字尾部的最大数字 + 1，作为新代理编号起点。 */
export function nextNameStart(existingNames) {
  let max = 0;
  for (const name of existingNames || []) {
    const match = String(name || '').trim().match(/(\d+)\s*$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/** 账号洗牌后轮发均分到目标代理（各组数量差 ≤ 1）。 */
export function distributeAccounts(accountIds, targets) {
  const shuffled = [...accountIds];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return targets.map((proxy, index) => ({
    proxy,
    ids: shuffled.filter((_, i) => i % targets.length === index),
  }));
}

function unwrapPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && payload.data !== undefined) return payload.data;
  return payload;
}

function normalizeProxyList(payload) {
  const list = unwrapPayload(payload);
  return Array.isArray(list) ? list : [];
}

export function createProxyReplacer({ client, logger }) {
  return async function replaceProxies({ text, protocol = 'http', deleteOld = true }) {
    if (!PROXY_PROTOCOLS.includes(protocol)) {
      throw errors.validation('代理协议仅支持 http / https / socks5 / socks5h');
    }
    const parsed = parseReplaceLines(text);
    if (parsed.items.length === 0) {
      throw errors.validation('没有可用的代理行，请检查输入格式');
    }

    const existing = normalizeProxyList(await client.listProxies({ withCount: true }));
    // 与现有代理完全一致（host/端口/账号/密码）的输入行视为复用：作为改绑目标但不重建、不删除
    const reused = [];
    const reusedIds = new Set();
    const toCreate = [];
    for (const item of parsed.items) {
      const identity = proxyIdentity(item);
      const match = existing.find((proxy) => proxyIdentity(proxy) === identity);
      if (match) {
        reused.push(match);
        reusedIds.add(Number(match.id));
      } else {
        toCreate.push(item);
      }
    }

    // 名字纯数字续接自增（上游批量创建接口会把名字统一写成 default，只能逐个建）
    const nameStart = nextNameStart(existing.map((proxy) => proxy.name));
    const created = [];
    const createFailed = [];
    for (let i = 0; i < toCreate.length; i += 1) {
      const item = toCreate[i];
      const name = String(nameStart + i);
      try {
        const payload = unwrapPayload(await client.createProxy({
          name,
          protocol,
          host: item.host,
          port: item.port,
          ...(item.username ? { username: item.username } : {}),
          ...(item.password ? { password: item.password } : {}),
        }));
        const id = Number(payload?.id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('sub2api 未返回代理 ID');
        created.push({ id, name: String(payload?.name || name), host: item.host, port: item.port });
      } catch (error) {
        createFailed.push({ proxy: `${item.host}:${item.port}`, reason: error.message });
        logger?.warn?.({ host: item.host, port: item.port, err: error.message }, 'sub2api create proxy failed');
      }
    }

    const targets = [
      ...created,
      ...reused.map((proxy) => ({ id: Number(proxy.id), name: proxy.name, host: proxy.host, port: proxy.port })),
    ];
    if (targets.length === 0) {
      throw new AppError(502, 'SUB2API_PROXY_CREATE_FAILED', `新代理创建全部失败：${createFailed[0]?.reason ?? '未知错误'}`);
    }

    // 只改绑"绑定在待删旧代理上"的账号；复用代理上已有的绑定保持不动
    const deletableOldIds = new Set(
      existing.filter((proxy) => !reusedIds.has(Number(proxy.id))).map((proxy) => Number(proxy.id)),
    );
    const accounts = await client.listAllOpenAiAccounts();
    const boundAccountIds = accounts
      .filter((account) => {
        const proxyId = Number(account?.proxy_id);
        return Number.isSafeInteger(proxyId) && deletableOldIds.has(proxyId);
      })
      .map((account) => Number(account.id));

    const groups = [];
    const failedGroups = [];
    for (const { proxy, ids } of distributeAccounts(boundAccountIds, targets)) {
      if (ids.length === 0) continue;
      try {
        await client.bulkUpdateAccounts({ account_ids: ids, proxy_id: proxy.id });
        groups.push({ proxy_id: proxy.id, name: proxy.name, count: ids.length });
      } catch (error) {
        failedGroups.push({ proxy_id: proxy.id, name: proxy.name, count: ids.length, reason: error.message });
        logger?.warn?.({ proxyId: proxy.id, count: ids.length, err: error.message }, 'sub2api bulk rebind failed');
      }
    }

    const oldProxies = { deleted: 0, skipped: [] };
    if (deleteOld && deletableOldIds.size > 0) {
      try {
        await client.deleteProxiesBatch([...deletableOldIds]);
      } catch (error) {
        logger?.warn?.({ err: error.message }, 'sub2api batch delete proxies failed');
      }
      // 以上游实际列表为准统计删除结果：仍存在的视为跳过（通常是仍有账号绑定）
      const remaining = normalizeProxyList(await client.listProxies({ withCount: true }));
      const remainingOld = remaining.filter((proxy) => deletableOldIds.has(Number(proxy.id)));
      oldProxies.deleted = deletableOldIds.size - remainingOld.length;
      oldProxies.skipped = remainingOld.map((proxy) => ({
        id: Number(proxy.id),
        name: proxy.name,
        reason: Number(proxy.account_count) > 0 ? `仍有 ${proxy.account_count} 个账号绑定` : '删除未生效（可能被其他平台账号绑定）',
      }));
    }

    return {
      created,
      reused: reused.map((proxy) => ({ id: Number(proxy.id), name: proxy.name, host: proxy.host, port: proxy.port })),
      create_failed: createFailed,
      invalid_lines: parsed.invalid_lines,
      duplicates_in_input: parsed.duplicates_in_input,
      name_start: nameStart,
      rebound: {
        total: boundAccountIds.length,
        groups,
        failed_groups: failedGroups,
      },
      old_proxies: oldProxies,
    };
  };
}
