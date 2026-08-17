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
  return { dataDir, db, crypto, pools, submitted: [], remoteAccounts: [] };
}

function insertAccount(db, { email, pool = 'main', status = 'active' }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, imported_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?)`,
    )
    .run(email, pool, status, 'ok', now, now, now);
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
    uploader: null,
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

test('补号计数：reserve 池在途 joining（有活跃任务）计入可用，不重复补号', async () => {
  insertAccount(ctx.db, { email: 'ok@test.local' });
  const joiningId = insertAccount(ctx.db, { email: 'inflight@test.local', pool: 'reserve', status: 'joining' });
  insertRunningJob(ctx.db, joiningId);
  insertAccount(ctx.db, { email: 'cand@test.local', pool: 'reserve', status: 'mail_ok' });
  const monitor = buildMonitor({
    threshold: 2,
    remoteAccounts: [remoteAccount({ id: 1, email: 'ok@test.local' })],
  });

  const view = await monitor.runCheck();

  assert.equal(view.last_result.available_count, 2);
  assert.equal(view.last_result.replenished, 0);
  assert.equal(ctx.submitted.length, 0);
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
