import { sanitizeText } from '../../lib/sanitize.js';
import { proxyIdentity, nextNameStart, distributeAccounts } from '../sub2api/proxy-replace.js';
import { buildProxyUrlFromItem, insertProxy, persistTestResult, localProxyIdentity } from './import-helper.js';
import { fetchNewProxies } from './provider-fetch.js';

/**
 * 代理自动巡检（默认每 60 秒一轮，面向动态住宅 IP 场景）：
 *  - 定时测活本机代理列表（复用测活 worker，与手动测活互斥；判定口径一致：chatgpt.com 可达性）
 *  - dead / cf_challenge 连续 remove_dead_after 轮不活 → 自动删除本机代理（动态住宅 IP 失效不可恢复）
 *  - 可用（alive）低于 min_alive 且配置了服务商 API → 自动提取新 IP：
 *      本机以 extract_protocol_local（默认 socks5h）导入；
 *      sub2api 侧以 extract_protocol_sub2api（默认 socks5）创建，保持两边镜像
 *  - sync_sub2api：按 host|port|user|pass 身份匹配 sub2api 死代理 → 绑在其上的账号洗牌均分
 *    改绑到（新提取 + 未死的现有）代理 → 删除死代理（上游对仍有绑定的自动跳过）
 * 每轮结果写 proxy_patrol_logs，保留最近 100 轮。
 */

const LOG_ROUNDS_RETAINED = 100;
const MIN_INTERVAL_SECONDS = 30;

export function createProxyPatrol({ db, crypto, testWorker, getConfig, getSub2api, logger }) {
  const state = {
    running: false,
    timer: null,
    lastCheckAt: null,
    nextCheckAt: null,
    lastError: null,
    lastResult: null,
  };

  function patrolConfig() {
    return getConfig() || {};
  }

  function startIfEnabled() {
    stop();
    const config = patrolConfig();
    if (!config.enabled) return;
    const intervalMs = Math.max(MIN_INTERVAL_SECONDS, Number(config.interval_seconds) || 60) * 1000;
    state.timer = setInterval(() => {
      runRound({ source: 'timer' }).catch((error) => {
        state.lastError = sanitizeText(String(error.message || error)).slice(0, 400);
        logger.error({ err: error.message }, 'proxy patrol round failed');
      });
    }, intervalMs);
    state.timer.unref?.();
    state.nextCheckAt = new Date(Date.now() + intervalMs).toISOString();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.nextCheckAt = null;
  }

  function view() {
    const config = patrolConfig();
    const alive = db.prepare(`SELECT COUNT(*) AS n FROM proxies WHERE status='alive'`).get().n;
    return {
      enabled: Boolean(config.enabled),
      running: state.running,
      interval_seconds: config.interval_seconds ?? 60,
      remove_dead_after: config.remove_dead_after ?? 2,
      auto_extract: Boolean(config.auto_extract),
      provider_api_url: config.provider_api_url || '',
      min_alive: config.min_alive ?? 3,
      extract_protocol_sub2api: config.extract_protocol_sub2api ?? 'socks5',
      extract_protocol_local: config.extract_protocol_local ?? 'socks5h',
      sync_sub2api: config.sync_sub2api !== false,
      alive_count: alive,
      last_check_at: state.lastCheckAt,
      next_check_at: state.nextCheckAt,
      last_error: state.lastError,
      last_result: state.lastResult,
    };
  }

  function startLog(source) {
    const info = db
      .prepare('INSERT INTO proxy_patrol_logs(source, started_at, status) VALUES (?, ?, ?)')
      .run(source, new Date().toISOString(), 'running');
    return Number(info.lastInsertRowid);
  }

  function finishLog(logId, status, summary, error = null) {
    db.prepare('UPDATE proxy_patrol_logs SET finished_at=?, status=?, error=?, summary=? WHERE id=?').run(
      new Date().toISOString(),
      status,
      error ? sanitizeText(error).slice(0, 400) : null,
      JSON.stringify(summary ?? {}),
      logId,
    );
    db.prepare(
      `DELETE FROM proxy_patrol_logs WHERE id NOT IN (SELECT id FROM proxy_patrol_logs ORDER BY id DESC LIMIT ${LOG_ROUNDS_RETAINED})`,
    ).run();
  }

  function recentLogs(limit = 20) {
    const rows = db
      .prepare('SELECT * FROM proxy_patrol_logs ORDER BY id DESC LIMIT ?')
      .all(Math.min(100, Math.max(1, limit)));
    return rows.map((row) => {
      let summary = {};
      try {
        summary = JSON.parse(row.summary || '{}');
      } catch {
        summary = {};
      }
      return {
        id: row.id,
        source: row.source,
        started_at: row.started_at,
        finished_at: row.finished_at,
        status: row.status,
        error: row.error,
        summary,
      };
    });
  }

  function loadLocalProxies() {
    return db
      .prepare('SELECT id, url_enc, status, consecutive_dead FROM proxies')
      .all()
      .map((row) => ({
        id: row.id,
        url: crypto.tryDecrypt(row.url_enc, 'proxies.url_enc'),
        status: row.status,
        consecutive_dead: row.consecutive_dead || 0,
      }))
      .filter((proxy) => proxy.url);
  }

  /** 一批测活：置 testing → worker 执行 → 结果落库；异常时把遗留 testing 复位。 */
  async function runTestBatch(targets) {
    const now = new Date().toISOString();
    const markTx = db.transaction(() => {
      for (const target of targets) {
        db.prepare(`UPDATE proxies SET status='testing', updated_at=? WHERE id=?`).run(now, target.id);
      }
    });
    markTx();
    try {
      await testWorker.testProxies(targets, (id, result) => {
        persistTestResult(db, id, result, { countCfAsDead: true });
      });
    } catch (error) {
      db.prepare(`UPDATE proxies SET status='unknown', updated_at=? WHERE status='testing'`).run(
        new Date().toISOString(),
      );
      throw error;
    }
  }

  /**
   * 死 IP 同步 sub2api：创建新提取的代理 → 把绑在死代理上的账号洗牌均分改绑到
   * （新代理 + 未死的现有代理）→ 删除死代理（上游对仍有账号绑定的自动跳过）。
   */
  async function syncDeadToSub2api(client, deadIdentities, newItems, protocol) {
    const result = {
      created: 0,
      create_failed: 0,
      rebound_total: 0,
      rebound_groups: 0,
      failed_groups: 0,
      deleted: 0,
      skipped: [],
    };
    const existing = normalizeProxyList(await client.listProxies({ withCount: true }));
    const deadRemote = existing.filter((proxy) => deadIdentities.has(proxyIdentity(proxy)));
    const deadRemoteIds = new Set(deadRemote.map((proxy) => Number(proxy.id)));
    const existingByIdentity = new Map(existing.map((proxy) => [proxyIdentity(proxy), proxy]));

    // 新提取条目：与现有完全相同（host/port/凭据）的复用，其余逐个创建（名字数字续接）
    const targets = [];
    const targetIds = new Set();
    const toCreate = [];
    for (const item of newItems) {
      const match = existingByIdentity.get(proxyIdentity(item));
      if (match) {
        if (!deadRemoteIds.has(Number(match.id)) && !targetIds.has(Number(match.id))) {
          targets.push({ id: Number(match.id), name: match.name });
          targetIds.add(Number(match.id));
        }
      } else {
        toCreate.push(item);
      }
    }
    const nameStart = nextNameStart(existing.map((proxy) => proxy.name));
    for (let i = 0; i < toCreate.length; i += 1) {
      const item = toCreate[i];
      try {
        const payload = unwrapPayload(
          await client.createProxy({
            name: String(nameStart + i),
            protocol,
            host: item.host,
            port: item.port,
            ...(item.username ? { username: item.username } : {}),
            ...(item.password ? { password: item.password } : {}),
          }),
        );
        const id = Number(payload?.id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('sub2api 未返回代理 ID');
        targets.push({ id, name: String(payload?.name || nameStart + i) });
        targetIds.add(id);
        result.created += 1;
      } catch (error) {
        result.create_failed += 1;
        logger?.warn?.({ host: item.host, port: item.port, err: error.message }, 'patrol create sub2api proxy failed');
      }
    }
    // 未死的现有代理也作为改绑目标（有新代理时分散压力，无新代理时兜底承接）
    for (const proxy of existing) {
      const id = Number(proxy.id);
      if (!deadRemoteIds.has(id) && !targetIds.has(id)) {
        targets.push({ id, name: proxy.name });
        targetIds.add(id);
      }
    }

    if (deadRemoteIds.size > 0) {
      const accounts = await client.listAllOpenAiAccounts();
      const boundAccountIds = accounts
        .filter((account) => deadRemoteIds.has(Number(account?.proxy_id)))
        .map((account) => Number(account.id));
      if (boundAccountIds.length > 0 && targets.length > 0) {
        for (const { proxy, ids } of distributeAccounts(boundAccountIds, targets)) {
          if (ids.length === 0) continue;
          try {
            await client.bulkUpdateAccounts({ account_ids: ids, proxy_id: proxy.id });
            result.rebound_total += ids.length;
            result.rebound_groups += 1;
          } catch (error) {
            result.failed_groups += 1;
            logger?.warn?.({ proxyId: proxy.id, count: ids.length, err: error.message }, 'patrol sub2api rebind failed');
          }
        }
      } else if (boundAccountIds.length > 0 && targets.length === 0) {
        result.rebound_error = `${boundAccountIds.length} 个账号绑在死代理上，但无可用改绑目标`;
      }
      try {
        await client.deleteProxiesBatch([...deadRemoteIds]);
      } catch (error) {
        logger?.warn?.({ err: error.message }, 'patrol sub2api batch delete proxies failed');
      }
      // 以上游实际列表为准统计删除结果：仍存在的视为跳过（通常是仍有账号绑定）
      const remaining = normalizeProxyList(await client.listProxies({ withCount: true }));
      const remainingDead = remaining.filter((proxy) => deadRemoteIds.has(Number(proxy.id)));
      result.deleted = deadRemoteIds.size - remainingDead.length;
      result.skipped = remainingDead.map((proxy) => ({
        id: Number(proxy.id),
        name: proxy.name,
        reason: Number(proxy.account_count) > 0 ? `仍有 ${proxy.account_count} 个账号绑定` : '删除未生效',
      }));
    }
    return result;
  }

  async function runRound({ source = 'manual' } = {}) {
    if (state.running) return view();
    const config = patrolConfig();
    state.running = true;
    const logId = startLog(source);
    const summary = { tested: 0, alive: 0, dead: 0, cf_challenge: 0 };
    try {
      if (testWorker.isBusy()) {
        summary.skipped = 'test_worker_busy';
        finishLog(logId, 'skipped', summary);
        logger?.info?.('proxy patrol round skipped: test worker busy');
        return view();
      }
      const removeAfter = Math.max(0, Number(config.remove_dead_after) || 0);
      const minAlive = Math.max(1, Number(config.min_alive) || 1);

      // 1) 测活：全部非 dead 代理 + 未达删除阈值的 dead（给死代理一轮复测机会再删）
      const before = loadLocalProxies();
      const testTargets = before.filter(
        (proxy) => proxy.status !== 'dead' || proxy.consecutive_dead < removeAfter,
      );
      if (testTargets.length > 0) {
        await runTestBatch(testTargets.map(({ id, url }) => ({ id, url })));
      }
      summary.tested = testTargets.length;

      // 2) 统计与死代理收集（consecutive_dead 达阈值，且 remove_dead_after>0 才删）
      const after = loadLocalProxies();
      for (const proxy of after) {
        if (proxy.status === 'alive') summary.alive += 1;
        else if (proxy.status === 'dead') summary.dead += 1;
        else if (proxy.status === 'cf_challenge') summary.cf_challenge += 1;
      }
      const deadRows = removeAfter > 0
        ? after.filter(
            (proxy) =>
              (proxy.status === 'dead' || proxy.status === 'cf_challenge') &&
              proxy.consecutive_dead >= removeAfter,
          )
        : [];
      const deadIdentities = new Set();
      for (const proxy of deadRows) {
        const identity = localProxyIdentity(proxy.url);
        if (identity) deadIdentities.add(identity);
      }

      // 3) 可用低于阈值 → 服务商 API 自动提取（失败记入日志，不阻断后续清理/同步）
      let extractedItems = [];
      if (config.auto_extract && config.provider_api_url && summary.alive < minAlive) {
        const need = minAlive - summary.alive;
        summary.extract_requested = need;
        try {
          const fetched = await fetchNewProxies(config.provider_api_url, need);
          extractedItems = fetched.items;
          summary.extracted = fetched.items.length;
        } catch (error) {
          summary.extract_error = sanitizeText(String(error.message || error)).slice(0, 300);
          logger?.warn?.({ err: error.message }, 'proxy patrol extract failed');
        }
      }

      // 4) 新 IP 导入本机（url_hash 去重，重复不重复导入）
      const importedIds = [];
      const localProtocol = config.extract_protocol_local || 'socks5h';
      for (const item of extractedItems) {
        const inserted = insertProxy(db, crypto, buildProxyUrlFromItem(item, localProtocol));
        if (inserted.ok && Number.isInteger(inserted.id)) importedIds.push(inserted.id);
      }
      summary.imported_local = importedIds.length;

      // 5) 删除本机死代理（先解除 jobs 引用）
      if (deadRows.length > 0) {
        const tx = db.transaction(() => {
          for (const proxy of deadRows) {
            db.prepare('UPDATE jobs SET proxy_id = NULL WHERE proxy_id = ?').run(proxy.id);
            db.prepare('DELETE FROM proxies WHERE id = ?').run(proxy.id);
          }
        });
        tx();
      }
      summary.removed_local = deadRows.length;

      // 6) sub2api 同步：新 IP 建到远端 + 死代理账号改绑 + 删除死代理
      if (config.sync_sub2api !== false && (deadIdentities.size > 0 || extractedItems.length > 0)) {
        const sub2api = getSub2api?.();
        if (sub2api?.client && sub2api?.configured) {
          try {
            summary.sub2api = await syncDeadToSub2api(
              sub2api.client,
              deadIdentities,
              extractedItems,
              config.extract_protocol_sub2api || 'socks5',
            );
          } catch (error) {
            summary.sub2api_error = sanitizeText(String(error.message || error)).slice(0, 300);
            logger?.warn?.({ err: error.message }, 'proxy patrol sub2api sync failed');
          }
        } else {
          summary.sub2api_error = 'sub2api 未配置，跳过同步';
        }
      }

      // 7) 本轮新导入的代理立即补测，尽快进入可用池
      if (importedIds.length > 0 && !testWorker.isBusy()) {
        try {
          const fresh = db
            .prepare(`SELECT id, url_enc FROM proxies WHERE id IN (${importedIds.map(() => '?').join(',')})`)
            .all(...importedIds)
            .map((row) => ({ id: row.id, url: crypto.tryDecrypt(row.url_enc, 'proxies.url_enc') }))
            .filter((proxy) => proxy.url);
          if (fresh.length > 0) await runTestBatch(fresh);
          summary.retested_new = fresh.length;
        } catch (error) {
          logger?.warn?.({ err: error.message }, 'proxy patrol retest new imports failed');
        }
      }

      state.lastCheckAt = new Date().toISOString();
      state.lastError = null;
      state.lastResult = summary;
      finishLog(logId, 'done', summary);
      logger?.info?.(summary, 'proxy patrol round done');
    } catch (error) {
      finishLog(logId, 'failed', summary, String(error.message || error));
      state.lastError = sanitizeText(String(error.message || error)).slice(0, 400);
      throw error;
    } finally {
      state.running = false;
    }
    return view();
  }

  /** 手动触发一轮（后台执行不阻塞 HTTP）。 */
  function checkInBackground() {
    void runRound({ source: 'manual' }).catch(() => {});
  }

  return { startIfEnabled, stop, view, runRound, checkInBackground, recentLogs, state };
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
