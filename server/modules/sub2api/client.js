import { AppError } from '../../lib/http-errors.js';
import { sanitizeText } from '../../lib/sanitize.js';

/**
 * sub2api admin API 客户端：x-api-key 头、120s 超时。
 * 错误信息过脱敏后抛 SUB2API_UNAVAILABLE / UPSTREAM_ERROR。
 */

const REQUEST_TIMEOUT_MS = 120_000;

export function createSub2apiClient(getConfig) {
  async function request(endpoint, options = {}, configOverride = null) {
    const config = configOverride || getConfig();
    if (!config?.base_url) throw new AppError(400, 'SUB2API_NOT_CONFIGURED', '请先配置 sub2api 后端地址');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${config.base_url.replace(/\/+$/, '')}${endpoint}`, {
        ...options,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': config.admin_key,
          ...(options.headers || {}),
        },
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
      if (!response.ok) {
        const message = responseMessage(payload, text).slice(0, 400);
        throw new AppError(502, 'SUB2API_UNAVAILABLE', `sub2api 返回 HTTP ${response.status}${message ? `：${message}` : ''}`);
      }
      return payload;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error?.name === 'AbortError') {
        throw new AppError(504, 'SUB2API_UNAVAILABLE', 'sub2api 请求超时（120s）');
      }
      throw new AppError(502, 'SUB2API_UNAVAILABLE', `无法连接 sub2api：${sanitizeText(String(error.message || error))}`);
    } finally {
      clearTimeout(timer);
    }
  }

  function listGroups() {
    return request('/api/v1/admin/groups/all?platform=openai');
  }

  function listProxies({ withCount = false } = {}) {
    return request(`/api/v1/admin/proxies/all${withCount ? '?with_count=true' : ''}`);
  }

  function createProxy(proxy) {
    return request('/api/v1/admin/proxies', { method: 'POST', body: JSON.stringify(proxy) });
  }

  function deleteProxiesBatch(ids) {
    return request('/api/v1/admin/proxies/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) });
  }

  function bulkUpdateAccounts(payload) {
    return request('/api/v1/admin/accounts/bulk-update', { method: 'POST', body: JSON.stringify(payload) });
  }

  async function listAllOpenAiAccounts({ status = null } = {}, configOverride = null) {
    let page = 1;
    let pages = 1;
    const accounts = [];
    do {
      const query = new URLSearchParams({ page: String(page), page_size: '100', platform: 'openai' });
      if (status) query.set('status', status);
      const payload = await request(`/api/v1/admin/accounts?${query}`, {}, configOverride);
      const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
      const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
      accounts.push(...items.filter((account) => account && String(account.platform || 'openai') === 'openai'));
      const reportedPages = Number(data?.pages);
      pages = Number.isSafeInteger(reportedPages) && reportedPages > 0 ? reportedPages : items.length >= 100 ? page + 1 : page;
      page += 1;
    } while (page <= pages && page <= 1000);
    return accounts;
  }

  function getAccount(id) {
    return request(`/api/v1/admin/accounts/${id}`);
  }

  function createAccountsBatch(accounts, idempotencyKey) {
    return request('/api/v1/admin/accounts/batch', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ accounts }),
    });
  }

  function updateAccount(id, payload) {
    return request(`/api/v1/admin/accounts/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  }

  function clearError(id) {
    return request(`/api/v1/admin/accounts/${id}/clear-error`, { method: 'POST', body: '{}' });
  }

  function setSchedulable(id, schedulable) {
    return request(`/api/v1/admin/accounts/${id}/schedulable`, {
      method: 'POST',
      body: JSON.stringify({ schedulable }),
    });
  }

  /** 账号邮箱提取：credentials.email → extra.email → name 正则。 */
  function accountEmail(account) {
    const direct = [account?.credentials?.email, account?.extra?.email]
      .map((value) => String(value || '').trim().toLowerCase())
      .find((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
    if (direct) return direct;
    const match = String(account?.name || '').toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
    return match ? match[0] : null;
  }

  /** 错误信息提取（多字段），供分类器拼接匹配。 */
  function accountErrorMessage(account) {
    return [account?.error_message, account?.last_error, account?.message, account?.error?.message]
      .map((value) => (typeof value === 'string' ? value : ''))
      .filter(Boolean)
      .join(' | ');
  }

  /** OAuth 号限流态：sub2api 不写 status=error，用 rate_limited_at/rate_limit_reset_at 表示。 */
  function accountRateLimit(account) {
    const rateLimitedAt = account?.rate_limited_at ?? null;
    const resetAt = account?.rate_limit_reset_at ?? null;
    let limitedNow = Boolean(rateLimitedAt);
    if (limitedNow && resetAt) {
      const resetMs = Date.parse(resetAt);
      if (Number.isFinite(resetMs) && resetMs <= Date.now()) limitedNow = false; // 重置时间已过，脏标记
    }
    return { rate_limited_at: rateLimitedAt, rate_limit_reset_at: resetAt, limited_now: limitedNow };
  }

  async function testConnection(configOverride) {
    const t0 = Date.now();
    const payload = await request('/api/v1/admin/groups/all?platform=openai', {}, configOverride);
    const groups = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
    return { ok: true, groups: groups.length, latency_ms: Date.now() - t0 };
  }

  return {
    request,
    listGroups,
    listProxies,
    createProxy,
    deleteProxiesBatch,
    bulkUpdateAccounts,
    listAllOpenAiAccounts,
    getAccount,
    createAccountsBatch,
    updateAccount,
    clearError,
    setSchedulable,
    accountEmail,
    accountErrorMessage,
    accountRateLimit,
    testConnection,
  };
}

function responseMessage(payload, text) {
  const message = payload?.error?.message || payload?.message || payload?.error || '';
  return typeof message === 'string' && message.trim() ? message.trim() : String(text || '').slice(0, 160);
}
