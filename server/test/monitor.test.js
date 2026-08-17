import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { createMonitor } from '../modules/sub2api/monitor.js';
import { createPools } from '../modules/accounts/pools.js';

const logger = createLogger('silent');

let ctx;

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-monitor-'));
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const pools = createPools(db, crypto);
  return { dataDir, db, crypto, pools, submitted: [], uploads: [], remoteAccounts: [] };
}

function insertAccount(db, { email, pool = 'main', status = 'active', tokens = false, balance = null }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, tokens_enc, balance, imported_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .run(email, pool, status, 'ok', tokens ? 'enc-blob' : null, balance, now, now, now);
  return Number(result.lastInsertRowid);
}

function insertRunningJob(db, accountId) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO jobs(id, account_id, type, status, log_path, created_at, updated_at) VALUES(?,?,?,?,?,?,?)`).run(
    `job-${accountId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    accountId,
    'login',
    'running',
    'logs/mock.log',
    now,
    now,
  );
}

function remoteAccount({ id, email, status = 'active', rateLimitedAt = null, resetAt = null, name = null }) {
  return {
    id,
    type: 'oauth',
    status,
    name: name || `oauth---${email}`,
    credentials: { email },
    rate_limited_at: rateLimitedAt,
    rate_limit_reset_at: resetAt,
    error_message: status === 'error' ? '401 unauthorized' : null,
  };
}

function buildMonitor({ threshold = 10, remoteAccounts = [], autoRepair = false } = {}) {
  const client = {
    listAllOpenAiAccounts: async () => remoteAccounts,
    accountEmail: (account) => account?.credentials?.email || null,
    accountRateLimit: (account) => {
      let limitedNow = Boolean(account?.rate_limited_at);
      if (limitedNow && account?.rate_limit_reset_at) {
        const resetMs = Date.parse(account.rate_limit_reset_at);
        if (Number.isFinite(resetMs) && resetMs <= Date.now()) limitedNow = false;
      }
      return { rate_limited_at: account?.rate_limited_at ?? null, rate_limit_reset_at: account?.rate_limit_reset_at ?? null, limited_now: limitedNow };
    },
    accountErrorMessage: (account) => account?.error_message || '',
    setSchedulable: async () => {},
  };
  const getConfig = () => ({
    base_url: 'http://sub2api.test',
    admin_key: 'sk-test',
    group_ids: [],
    monitor: {
      enabled: true,
      auto_repair: autoRepair,
      auto_replenish: true,
      reserve_threshold: threshold,
      banned_patterns: ['401'],
      rate_limit_patterns: ['429', 'rate limit'],
    },
  });
  return createMonitor({
    db: ctx.db,
    crypto: ctx.crypto,
    client,
    getConfig,
    pools: ctx.pools,
    engine: { submitJob: (job) => ctx.submitted.push(job) },
    uploader: {
      uploadAccounts: async (ids, options) => {
        ctx.uploads.push({ ids: [...ids], options });
        return { created: ids.length, updated: 0, failed: [], updated_account_ids: [] };
      },
    },
    banMailCheck: null,
    logger,
  });
}

beforeEach(() => {
  ctx = setup();
});

test('补号计数：远端正常的主池号计入，达到阈值不补', async () => {
  const emails = ['a@test.local', 'b@test.local', 'c@test.local'];
  for (const email of emails) insertAccount(ctx.db, { email });
  const monitor = buildMonitor({
    threshold: 3,
    remoteAccounts: emails.map((email, i) => remoteAccount({ id: i + 1, email })),
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 3);
  assert.equal(view.last_result.replenished, 0);
  assert.equal(ctx.submitted.length, 0);
});

test('补号计数：限流中（429）的号不计入，缺口触发补号', async () => {
  insertAccount(ctx.db, { email: 'ok@test.local' });
  insertAccount(ctx.db, { email: 'limited@test.local' });
  insertAccount(ctx.db, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'ok@test.local' }),
      // 短期限流（1 小时后重置）：保留主池观察，但补号计数必须剔除
      remoteAccount({ id: 2, email: 'limited@test.local', rateLimitedAt: new Date().toISOString(), resetAt: new Date(Date.now() + 3600_000).toISOString() }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
  assert.equal(ctx.submitted.length, 1);
  assert.equal(ctx.submitted[0].type, 'login');
  const candidate = ctx.db.prepare(`SELECT pool, status FROM accounts WHERE email='cand@test.local'`).get();
  assert.equal(candidate.pool, 'reserve');
  assert.equal(candidate.status, 'joining');
});

test('补号计数：401 error 号废弃后不计入，缺口触发补号', async () => {
  insertAccount(ctx.db, { email: 'ok@test.local' });
  insertAccount(ctx.db, { email: 'banned@test.local' });
  insertAccount(ctx.db, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'ok@test.local' }),
      remoteAccount({ id: 2, email: 'banned@test.local', status: 'error' }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.discarded, 1);
  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
});

test('补号计数：他人上传的号（本地无记录）不计入', async () => {
  insertAccount(ctx.db, { email: 'mine@test.local' });
  insertAccount(ctx.db, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'mine@test.local' }),
      remoteAccount({ id: 2, email: 'stranger@test.local' }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
});

test('补号计数：已废弃号远端未删不计入', async () => {
  insertAccount(ctx.db, { email: 'ok@test.local' });
  const discardedId = insertAccount(ctx.db, { email: 'gone@test.local' });
  ctx.pools.moveToDiscard(discardedId, 'rate_limited_429', '限流至下个月');
  insertAccount(ctx.db, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'ok@test.local' }),
      // 远端还挂着、status 还是 active，但本地已废弃 → 不计入
      remoteAccount({ id: 2, email: 'gone@test.local' }),
    ],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
});

test('补号计数：reserve 池在途 joining（有活跃任务）计入可用与库存，按缺口补足不超发', async () => {
  insertAccount(ctx.db, { email: 'ok@test.local' });
  const joiningId = insertAccount(ctx.db, { email: 'inflight@test.local', pool: 'reserve', status: 'joining' });
  insertRunningJob(ctx.db, joiningId);
  insertAccount(ctx.db, { email: 'c1@test.local', pool: 'reserve', status: 'mail_ok' });
  insertAccount(ctx.db, { email: 'c2@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 2);
  // 在途 joining 计入库存（库存 1）→ 只补 1 个到保底 2，而不是把 2 个候选全发出去
  assert.equal(view.last_result.replenished, 1);
  assert.equal(ctx.submitted.length, 1);
});

test('补号计数：僵尸 joining（无活跃任务）不计入可用', async () => {
  insertAccount(ctx.db, { email: 'ok@test.local' });
  insertAccount(ctx.db, { email: 'zombie@test.local', pool: 'reserve', status: 'joining' });
  insertAccount(ctx.db, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.replenished, 1);
  // 僵尸 joining 不符合候选资格，补的是 mail_ok 号
  const candidate = ctx.db.prepare(`SELECT email FROM accounts WHERE status='joining' AND email='cand@test.local'`).get();
  assert.ok(candidate);
});

test('补号并发：单轮最多补 3 个', async () => {
  for (const email of ['c1@test.local', 'c2@test.local', 'c3@test.local', 'c4@test.local', 'c5@test.local']) {
    insertAccount(ctx.db, { email, pool: 'reserve', status: 'mail_ok' });
  }
  const monitor = buildMonitor({ threshold: 6, remoteAccounts: [] });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 0);
  assert.equal(view.last_result.replenished, 3);
  assert.equal(ctx.submitted.length, 3);
});

test('级联补号：库存充足（补完缺口仍不低于保底）时备用池不动；余额小/未知余额的先上', async () => {
  insertAccount(ctx.db, { email: 'ok@test.local' });
  const unknownId = insertAccount(ctx.db, { email: 'unknown@test.local', tokens: true });
  const smallId = insertAccount(ctx.db, { email: 'small@test.local', tokens: true, balance: 3 });
  for (const email of ['big@test.local', 's4@test.local', 's5@test.local']) {
    insertAccount(ctx.db, { email, tokens: true, balance: 20 });
  }
  insertAccount(ctx.db, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 3,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
  });

  const view = await monitor.runCheck();

  // 可用 1、缺口 2：库存 5 个，上传 2 后剩余 3 仍等于保底 → 备用池不动
  assert.equal(view.last_result.available_count, 1);
  assert.equal(view.last_result.uploaded, 2);
  assert.equal(ctx.uploads.length, 1);
  // 未知余额（NULL 视为 0）与余额小的先上传
  assert.deepEqual(ctx.uploads[0].ids, [unknownId, smallId]);
  assert.equal(view.last_result.replenished, 0);
  assert.equal(ctx.submitted.length, 0);
  assert.equal(view.last_result.stock_count, 3);
});

test('级联补号：库存补不满缺口时，上传全部库存并从备用池登录补库存', async () => {
  insertAccount(ctx.db, { email: 'ok@test.local' });
  insertAccount(ctx.db, { email: 's1@test.local', tokens: true });
  insertAccount(ctx.db, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  insertAccount(ctx.db, { email: 'cand2@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 4,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
  });

  const view = await monitor.runCheck();

  // 可用 1、缺口 3：库存 1 个全部上传，剩余库存 0 低于保底 4 → 备用池登录补入 min(3, 4) 个，候选只有 2
  assert.equal(view.last_result.uploaded, 1);
  assert.equal(ctx.uploads[0].ids.length, 1);
  assert.equal(view.last_result.replenished, 2);
  assert.equal(ctx.submitted.length, 2);
  assert.equal(ctx.submitted[0].type, 'login');
  assert.equal(view.last_result.stock_count, 0);
});

test('级联补号：sub2api 可用够（无缺口），主池库存低于保底仍从备用池登录补库存', async () => {
  const emails = ['a@test.local', 'b@test.local', 'c@test.local'];
  for (const email of emails) insertAccount(ctx.db, { email });
  insertAccount(ctx.db, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 3,
    remoteAccounts: emails.map((email, i) => remoteAccount({ id: i + 1, email })),
  });

  const view = await monitor.runCheck();

  // 无缺口不上传，但库存 0 低于保底 3 → 备用池登录补入 min(3, 3) 个，候选只有 1
  assert.equal(view.last_result.available_count, 3);
  assert.equal(view.last_result.uploaded, 0);
  assert.equal(ctx.uploads.length, 0);
  assert.equal(view.last_result.replenished, 1);
  assert.equal(ctx.submitted.length, 1);
  assert.equal(view.last_result.stock_count, 0);
});

test('级联补号：远端已存在的主池号不重复上传', async () => {
  insertAccount(ctx.db, { email: 'ok@test.local' });
  // 远端已存在（短期限流中，保留主池）：不进上传候选
  insertAccount(ctx.db, { email: 'dupe@test.local', tokens: true });
  const freshId = insertAccount(ctx.db, { email: 'fresh@test.local', tokens: true });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [
      remoteAccount({ id: 1, email: 'ok@test.local' }),
      remoteAccount({
        id: 2,
        email: 'dupe@test.local',
        rateLimitedAt: new Date().toISOString(),
        resetAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
    ],
  });

  const view = await monitor.runCheck();

  // 可用 1、缺口 1：只上传 fresh，dupe 在远端已存在被跳过；缺口补满后备用池不动
  assert.equal(view.last_result.uploaded, 1);
  assert.deepEqual(ctx.uploads[0].ids, [freshId]);
  assert.equal(view.last_result.replenished, 0);
});
