import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { createUploader, balanceTierPriority, mergeUploadOptions } from '../modules/sub2api/upload.js';
import { buildMainBalanceEstimate } from '../modules/accounts/index.js';

const logger = createLogger('silent');

let ctx;

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-upload-'));
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  const created = [];
  const client = {
    listAllOpenAiAccounts: async () => [],
    accountEmail: (account) => account?.credentials?.email || null,
    createAccountsBatch: async (payloads) => {
      created.push(...payloads);
      return { data: [] };
    },
    listProxies: async () => [],
  };
  const uploader = createUploader({
    db,
    crypto,
    client,
    getConfig: () => ({ base_url: 'http://sub2api.test', admin_key: 'sk-test', group_ids: [], upload_defaults: {} }),
    settingsGet: () => null,
    dataDir,
    proxySelector: null,
    logger,
  });
  return { dataDir, db, crypto, uploader, created };
}

// 不带 access_token：余额为空时跳过实时补查，保持「未查过」口径
function insertAccount(db, crypto, { email, balance = null }) {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO accounts(email, pool, status, mail_status, tokens_enc, credentials_enc, balance, imported_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      email,
      'main',
      'active',
      'ok',
      crypto.encryptJson({ refresh_token: 'rt', email }, 'accounts.tokens_enc'),
      null,
      balance,
      now,
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

function priorityByEmail() {
  const map = new Map();
  for (const payload of ctx.created) map.set(payload.credentials.email, payload);
  return map;
}

beforeEach(() => {
  ctx = setup();
});

test('balanceTierPriority：四档边界与未知余额默认档', () => {
  assert.equal(balanceTierPriority(0), 40);
  assert.equal(balanceTierPriority(9.4), 40);
  assert.equal(balanceTierPriority(9.6), 40); // 四舍五入到 10，与 ---N 名称后缀同口径
  assert.equal(balanceTierPriority(10), 40);
  assert.equal(balanceTierPriority(10.6), 20);
  assert.equal(balanceTierPriority(15), 20);
  assert.equal(balanceTierPriority(19.6), 30);
  assert.equal(balanceTierPriority(25), 30);
  assert.equal(balanceTierPriority(39.4), 30);
  assert.equal(balanceTierPriority(39.6), 10);
  assert.equal(balanceTierPriority(40), 10);
  assert.equal(balanceTierPriority(null), 20); // 未查过按默认 10 刀档
  assert.equal(balanceTierPriority(undefined), 20);
});

test('上传默认按余额分档设置优先级，并追加余额后缀', async () => {
  const cases = [
    { email: 'small@test.local', balance: 5.4, priority: 40, suffix: '---5' },
    { email: 'mid@test.local', balance: 15, priority: 20, suffix: '---15' },
    { email: 'mid-high@test.local', balance: 25, priority: 30, suffix: '---25' },
    { email: 'big@test.local', balance: 40, priority: 10, suffix: '---40' },
    { email: 'unknown@test.local', balance: null, priority: 20, suffix: null },
  ];
  const ids = cases.map((c) => insertAccount(ctx.db, ctx.crypto, c));
  const result = await ctx.uploader.uploadAccounts(ids, {});
  assert.equal(result.created, 5);
  assert.equal(result.failed.length, 0);
  const byEmail = priorityByEmail();
  for (const c of cases) {
    const payload = byEmail.get(c.email);
    assert.ok(payload, `missing payload for ${c.email}`);
    assert.equal(payload.priority, c.priority, `${c.email} priority`);
    if (c.suffix) assert.ok(String(payload.name).endsWith(c.suffix), `${c.email} name suffix`);
    else assert.equal(String(payload.name), `oauth---${c.email}`);
  }
});

test('显式指定优先级时不做余额分档', async () => {
  const ids = [
    insertAccount(ctx.db, ctx.crypto, { email: 'a@test.local', balance: 5 }),
    insertAccount(ctx.db, ctx.crypto, { email: 'b@test.local', balance: 30 }),
  ];
  await ctx.uploader.uploadAccounts(ids, { priority: 99 });
  const byEmail = priorityByEmail();
  assert.equal(byEmail.get('a@test.local').priority, 99);
  assert.equal(byEmail.get('b@test.local').priority, 99);
});

test('主号池预估余额：按邮箱匹配并扣除管理端已用金额，负数归零', () => {
  const result = buildMainBalanceEstimate(
    [
      { id: 1, email: 'a@test.local', initial_balance: 20, sub2api_account_id: null },
      { id: 2, email: 'b@test.local', initial_balance: 5, sub2api_account_id: 22 },
      { id: 3, email: 'c@test.local', initial_balance: null, sub2api_account_id: 33 },
    ],
    [
      { id: 11, credentials: { email: 'a@test.local' }, used_amount: 6.4 },
      { id: 22, credentials: { email: 'b@test.local' }, usage: { total_cost: 8 } },
      { id: 33, credentials: { email: 'c@test.local' }, used_amount: 1 },
    ],
    {
      accountEmail: (account) => account?.credentials?.email || null,
      accountUsedAmount: (account) => {
        const value = account.used_amount ?? account.usage?.total_cost;
        return Number.isFinite(Number(value)) ? { amount: Number(value), source: 'test' } : null;
      },
    },
  );
  assert.equal(result.total_estimated_remaining, 13.6);
  assert.equal(result.calculable_count, 2);
  assert.equal(result.unknown_count, 1);
  assert.equal(result.items[1].estimated_remaining, 0);
  assert.equal(result.items[2].reason, 'initial_balance_unknown');
});

test('主号池预估余额：缺少远端用量时保持未知，不写入余额', () => {
  const result = buildMainBalanceEstimate(
    [{ id: 1, email: 'a@test.local', initial_balance: 20, sub2api_account_id: 7 }],
    [{ id: 7, credentials: { email: 'a@test.local' } }],
    { accountEmail: () => 'a@test.local', accountUsedAmount: () => null },
  );
  assert.equal(result.total_estimated_remaining, 0);
  assert.equal(result.unknown_count, 1);
  assert.equal(result.items[0].reason, 'remote_used_amount_unknown');
});

test('mergeUploadOptions：未显式覆盖时 priority 保持空，交给分档逻辑', () => {
  const merged = mergeUploadOptions({ priority: null }, { priority: null });
  assert.equal(merged.priority, null);
  const overridden = mergeUploadOptions({ priority: 5 }, { priority: null });
  assert.equal(overridden.priority, null); // 弹窗清空即显式取消默认值，与既有语义一致
});
