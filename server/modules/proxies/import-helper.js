import { normalizeProxyUrl } from '../../core/risk-control.mjs';
import { maskProxyUrl } from '../../lib/sanitize.js';
import { proxySupportsSessionRotation } from '../../core/tls-transport.mjs';

const PROTOCOLS = ['http:', 'https:', 'socks5:', 'socks5h:'];

/**
 * 解析后的代理条目（host/port/username/password）拼成完整代理 URL。
 * 凭据 encodeURIComponent 编码；无认证代理只拼 host:port。
 */
export function buildProxyUrlFromItem({ host, port, username, password }, protocol = 'socks5h') {
  const auth = username
    ? `${encodeURIComponent(username)}:${encodeURIComponent(password || '')}@`
    : '';
  return `${protocol}://${auth}${host}:${port}`;
}

/**
 * 归一化并插入一条本机代理（url_hash 去重，重复则仅更新备注）。
 * 返回 { ok, duplicate, reason }；reason 为归一化/协议校验失败原因。
 */
export function insertProxy(db, crypto, rawUrl, label = null) {
  let normalized;
  try {
    normalized = normalizeProxyUrl(rawUrl);
  } catch (error) {
    return { ok: false, duplicate: false, reason: error.message };
  }
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return { ok: false, duplicate: false, reason: 'URL 无法解析' };
  }
  if (!PROTOCOLS.includes(parsed.protocol)) {
    return { ok: false, duplicate: false, reason: `不支持的协议 ${parsed.protocol.replace(':', '')}` };
  }
  const urlHash = crypto.sha256Hex(normalized);
  const existing = db.prepare('SELECT id FROM proxies WHERE url_hash = ?').get(urlHash);
  const now = new Date().toISOString();
  if (existing) {
    if (label) {
      db.prepare('UPDATE proxies SET label=?, updated_at=? WHERE id=?').run(label, now, existing.id);
    }
    return { ok: false, duplicate: true, url: normalized };
  }
  const info = db
    .prepare(
      `INSERT INTO proxies(url_enc, url_hash, display_url, protocol, label, status, rotatable, created_at, updated_at)
       VALUES(?,?,?,?,?,'unknown',?,?,?)`,
    )
    .run(
      crypto.encrypt(normalized, 'proxies.url_enc'),
      urlHash,
      maskProxyUrl(normalized),
      parsed.protocol.replace(':', ''),
      label || null,
      proxySupportsSessionRotation(normalized) ? 1 : 0,
      now,
      now,
    );
  return { ok: true, duplicate: false, url: normalized, id: Number(info.lastInsertRowid) };
}

/**
 * 测活结果落库（test 路由与巡检共用）。
 * countCfAsDead=true 时 cf_challenge 也累计 consecutive_dead（巡检口径：动态住宅 IP 被 CF 拦即视为烧毁）。
 */
export function persistTestResult(db, id, result, { countCfAsDead = false } = {}) {
  const nowIso = new Date().toISOString();
  const treatDead = result.status === 'dead' || (countCfAsDead && result.status === 'cf_challenge');
  if (treatDead) {
    const row = db.prepare('SELECT consecutive_dead FROM proxies WHERE id=?').get(id);
    const consecutive = (row?.consecutive_dead || 0) + 1;
    db.prepare(
      `UPDATE proxies SET status=?, consecutive_dead=?, last_checked_at=?, last_latency_ms=?,
         last_error=?, updated_at=? WHERE id=?`,
    ).run(result.status, consecutive, nowIso, result.status === 'dead' ? null : result.latency, result.error ?? null, nowIso, id);
  } else {
    db.prepare(
      `UPDATE proxies SET status=?, consecutive_dead=0, last_checked_at=?, last_latency_ms=?,
         last_error=NULL, updated_at=? WHERE id=?`,
    ).run(result.status, nowIso, result.latency, nowIso, id);
  }
}

/** 本机代理 URL → host|port|user|pass 身份串（与 sub2api proxyIdentity 同口径，供两边匹配）。 */
export function localProxyIdentity(url) {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : null;
    if (!parsed.hostname || !Number.isInteger(port)) return null;
    return [
      parsed.hostname.toLowerCase(),
      port,
      parsed.username ? decodeURIComponent(parsed.username) : '',
      parsed.password ? decodeURIComponent(parsed.password) : '',
    ].join('|');
  } catch {
    return null;
  }
}
