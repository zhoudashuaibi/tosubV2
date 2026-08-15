/**
 * settings 服务：启动时整表载入内存缓存，写库后刷新缓存（单进程）。
 * secret key 的值整体加密（encrypted=1），读取时解密。
 */

const SECRET_KEYS = new Set(['console.password', 'sub2api.config', 'sms.providers']);

export const DEFAULT_SETTINGS = {
  'outlook.fetch': { endpoint: 'https://8t92.cc/api/fetch-mails' },
  'engine.config': {
    max_concurrent_jobs: 20,
    job_timeout_minutes: 30,
    proxy_fail_threshold: 3,
  },
  'sub2api.config': {
    base_url: '',
    admin_key: '',
    group_ids: [],
    upload_defaults: {
      concurrency: null,
      load_factor: null,
      priority: null,
      model_whitelist: [],
      disable_auto_pause_5h: false,
      disable_auto_pause_7d: false,
      auto_select_proxy: true,
      proxy_id: null,
    },
    monitor: {
      enabled: false,
      interval_minutes: 5,
      cooldown_minutes: 5,
      auto_repair: true,
      max_repair_attempts: 2,
      auto_replenish: false,
      reserve_threshold: 10,
      pause_on_discard: true,
      banned_patterns: ['account_deactivated', 'deactivated', 'suspended', 'banned', 'permanently deleted', '401'],
      rate_limit_patterns: ['429', 'rate limit', 'too many requests'],
    },
  },
  'sms.providers': {
    active: 'custom',
    luban: {},
    smsbower: {},
    custom: { entries: '' },
  },
};

export function createSettingsService(db, crypto, { logger = null } = {}) {
  const cache = new Map();

  function loadAll() {
    const rows = db.prepare('SELECT key, value, encrypted FROM settings').all();
    cache.clear();
    for (const row of rows) {
      let value = row.value;
      if (row.encrypted) {
        try {
          value = crypto.decrypt(row.value, `settings.${row.key}`);
        } catch (error) {
          logger?.error?.({ key: row.key }, `settings 解密失败，视为损坏：${error.message}`);
          continue;
        }
      }
      try {
        cache.set(row.key, JSON.parse(value));
      } catch {
        cache.set(row.key, value);
      }
    }
  }

  function get(key, fallback = undefined) {
    if (cache.has(key)) return cache.get(key);
    if (key in DEFAULT_SETTINGS) return structuredClone(DEFAULT_SETTINGS[key]);
    return fallback;
  }

  function set(key, value, { secret = SECRET_KEYS.has(key) } = {}) {
    const now = new Date().toISOString();
    const serialized = JSON.stringify(value ?? null);
    const stored = secret ? crypto.encrypt(serialized, `settings.${key}`) : serialized;
    db.prepare(
      `INSERT INTO settings(key, value, encrypted, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = excluded.updated_at`,
    ).run(key, stored, secret ? 1 : 0, now);
    cache.set(key, value);
    return value;
  }

  function ensureDefaults() {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      const row = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
      if (!row) set(key, structuredClone(value));
    }
  }

  function has(key) {
    return cache.has(key) || db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key) != null;
  }

  loadAll();

  return { get, set, has, ensureDefaults, reload: loadAll, SECRET_KEYS };
}
