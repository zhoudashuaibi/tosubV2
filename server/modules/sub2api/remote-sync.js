/**
 * sub2api 远端同步服务：
 *  - syncRemoteStatus：按 email/ID 把远端账号关联回本地（回填 sub2api_account_id），
 *    并镜像远端真实 status 到 sub2api_status；远端已不存在的本地关联一并清除
 *  - resolveSub2apiProxy：余额查询选路——号已上传 sub2api 时解析其在远端绑定的代理 URL
 *
 * 远端全量索引（账号/代理列表）带 60s TTL 缓存：批量余额查询、巡检、同步共享一次拉取。
 */

const CACHE_TTL_MS = 60_000;

/** 从 sub2api 代理字段构造代理 URL（protocol://user:pass@host:port）。 */
export function buildProxyUrl(proxy) {
  const protocol = String(proxy?.protocol || 'http').toLowerCase();
  if (!['http', 'https', 'socks5', 'socks5h'].includes(protocol)) return null;
  const host = String(proxy?.host || '').trim();
  const port = Number(proxy?.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const username = proxy?.username ? String(proxy.username) : '';
  const password = proxy?.password ? String(proxy.password || '') : '';
  const auth = username ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@` : '';
  return `${protocol}://${auth}${host}:${port}`;
}

export function createRemoteSync({ db, client, getConfig, logger }) {
  let cache = { accounts: null, accountsAt: 0, proxies: null, proxiesAt: 0 };

  function buildAccountIndex(list) {
    const byId = new Map();
    const byEmail = new Map();
    for (const account of list) {
      const id = Number(account?.id);
      if (Number.isSafeInteger(id) && id > 0) byId.set(id, account);
      const email = client.accountEmail(account);
      if (email) byEmail.set(email.toLowerCase(), account);
    }
    return { byId, byEmail };
  }

  async function remoteAccountIndex() {
    if (!cache.accounts || Date.now() - cache.accountsAt > CACHE_TTL_MS) {
      const index = buildAccountIndex(await client.listAllOpenAiAccounts());
      cache = { ...cache, accounts: index, accountsAt: Date.now() };
    }
    return cache.accounts;
  }

  async function remoteProxyIndex() {
    if (!cache.proxies || Date.now() - cache.proxiesAt > CACHE_TTL_MS) {
      const payload = await client.listProxies();
      const proxies = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
      const byId = new Map();
      for (const proxy of proxies) {
        const id = Number(proxy?.id);
        if (Number.isSafeInteger(id) && id > 0) byId.set(id, proxy);
      }
      cache = { ...cache, proxies: byId, proxiesAt: Date.now() };
    }
    return cache.proxies;
  }

  function recordEvent(accountId, type, detail) {
    db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
      accountId,
      type,
      JSON.stringify(detail || {}),
      new Date().toISOString(),
    );
  }

  /**
   * 同步远端状态到本地主号池：
   *  - 远端存在 → 回填 sub2api_account_id（缺失/不符时）+ 镜像 status + sub2api_synced_at
   *  - 远端不存在 → 清除本地 sub2api_account_id / sub2api_status（远端已被删除）
   * remoteAccounts：调用方已拉取的全量远端账号（巡检复用），缺省自行拉取。
   */
  async function syncRemoteStatus({ remoteAccounts = null } = {}) {
    const index = remoteAccounts ? buildAccountIndex(remoteAccounts) : await remoteAccountIndex();
    const rows = db
      .prepare(`SELECT id, email, sub2api_account_id, sub2api_status FROM accounts WHERE pool = 'main'`)
      .all();
    const now = new Date().toISOString();
    const stats = { scanned: rows.length, linked: 0, unlinked: 0, status_updated: 0 };
    const tx = db.transaction(() => {
      for (const row of rows) {
        const remote =
          (Number.isInteger(Number(row.sub2api_account_id)) && index.byId.get(Number(row.sub2api_account_id))) ||
          index.byEmail.get(String(row.email || '').toLowerCase()) ||
          null;
        if (remote) {
          const remoteId = Number(remote.id);
          const remoteStatus = String(remote.status || 'unknown');
          const idChanged = Number(row.sub2api_account_id) !== remoteId;
          if (!idChanged && row.sub2api_status === remoteStatus) continue;
          db.prepare(
            `UPDATE accounts SET sub2api_account_id=?, sub2api_status=?, sub2api_synced_at=?,
               sub2api_uploaded_at=COALESCE(sub2api_uploaded_at, ?), updated_at=? WHERE id=?`,
          ).run(remoteId, remoteStatus, now, now, now, row.id);
          if (idChanged) {
            recordEvent(row.id, 'sub2api_linked', { remote_id: remoteId, source: 'sync' });
            stats.linked += 1;
          } else {
            stats.status_updated += 1;
          }
        } else if (row.sub2api_account_id != null || row.sub2api_status != null) {
          db.prepare(
            `UPDATE accounts SET sub2api_account_id=NULL, sub2api_status=NULL, sub2api_synced_at=?, updated_at=? WHERE id=?`,
          ).run(now, now, row.id);
          recordEvent(row.id, 'sub2api_unlinked', { source: 'sync', reason: 'remote_missing' });
          stats.unlinked += 1;
        }
      }
    });
    tx();
    logger?.info?.(stats, 'sub2api remote sync done');
    return stats;
  }

  /**
   * 余额查询选路：号已上传 sub2api（按 ID 或 email 命中远端）且绑定了代理时，
   * 返回该代理的直连 URL；未配置 sub2api / 号不在远端 / 未绑代理返回 null（走本机选路）。
   */
  async function resolveSub2apiProxy(accountId) {
    const config = getConfig();
    if (!config?.base_url || !config?.admin_key) return null;
    const row = db.prepare('SELECT email, sub2api_account_id FROM accounts WHERE id = ?').get(accountId);
    if (!row) return null;
    const index = await remoteAccountIndex();
    const remote =
      (Number.isInteger(Number(row.sub2api_account_id)) && index.byId.get(Number(row.sub2api_account_id))) ||
      index.byEmail.get(String(row.email || '').toLowerCase()) ||
      null;
    const proxyId = Number(remote?.proxy_id);
    if (!Number.isSafeInteger(proxyId) || proxyId <= 0) return null;
    const proxy = (await remoteProxyIndex()).get(proxyId);
    const url = buildProxyUrl(proxy);
    if (!url) return null;
    return { url, remote_id: Number(remote.id), proxy_id: proxyId, proxy_name: proxy.name || null };
  }

  return { syncRemoteStatus, resolveSub2apiProxy };
}
