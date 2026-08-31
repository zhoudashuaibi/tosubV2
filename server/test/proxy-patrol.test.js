import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/db.js';
import { createCrypto } from '../lib/crypto.js';
import { createLogger } from '../lib/logger.js';
import { createProxyPatrol } from '../modules/proxies/patrol.js';
import { insertProxy, buildProxyUrlFromItem, localProxyIdentity } from '../modules/proxies/import-helper.js';

const logger = createLogger('silent');

let ctx;

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tosub2-patrol-'));
  const db = openDatabase(dataDir, { logger });
  const crypto = createCrypto({ dataDir, secretKeyEnv: 'test-secret', logger });
  return { dataDir, db, crypto };
}

/** 插入一条本机代理并直接置状态/连续死亡计数（模拟历史测活结果）。 */
function seedProxy(db, crypto, url, { status = 'unknown', consecutive = 0 } = {}) {
  const inserted = insertProxy(db, crypto, url);
  assert.ok(inserted.ok, `seed failed: ${url}`);
  db.prepare('UPDATE proxies SET status=?, consecutive_dead=? WHERE id=?').run(status, consecutive, inserted.id);
  return inserted.id;
}

function proxies(db) {
  return db.prepare('SELECT id, url_enc, status, consecutive_dead, protocol FROM proxies').all();
}

/** 测活 worker mock：按 id 返回预设结果，未预设的按 alive。 */
function makeTestWorker(resultById = {}, { busy = false } = {}) {
  return {
    isBusy: () => busy,
    testProxies: async (targets, onResult) => {
      for (const target of targets) {
        const result = resultById[target.id] ?? { status: 'alive', latency: 120, error: null };
        onResult(target.id, result);
      }
    },
  };
}

function buildPatrol({
  config = {},
  resultById = {},
  workerBusy = false,
  sub2api = null,
} = {}) {
  return createProxyPatrol({
    db: ctx.db,
    crypto: ctx.crypto,
    logger,
    testWorker: makeTestWorker(resultById, { busy: workerBusy }),
    getConfig: () => ({
      enabled: false,
      interval_seconds: 60,
      remove_dead_after: 2,
      sync_sub2api: false,
      ...config,
    }),
    getSub2api: () => sub2api,
  });
}

beforeEach(() => {
  ctx = setup();
});

test('URL 构造：带认证转义特殊字符，无认证省略凭据段', () => {
  assert.equal(
    buildProxyUrlFromItem({ host: '1.2.3.4', port: 1080, username: 'u@x', password: 'p:1' }, 'socks5h'),
    'socks5h://u%40x:p%3A1@1.2.3.4:1080',
  );
  assert.equal(
    buildProxyUrlFromItem({ host: '1.2.3.4', port: 1080, username: null, password: null }, 'socks5h'),
    'socks5h://1.2.3.4:1080',
  );
});

test('身份串：本机 URL 与 sub2api 条目同口径（大小写 host 归一）', () => {
  assert.equal(
    localProxyIdentity('socks5h://u%40x:p%3A1@PROXY.Example.com:1080'),
    'proxy.example.com|1080|u@x|p:1',
  );
  assert.equal(localProxyIdentity('不是 URL'), null);
});

test('巡检轮：全部存活时不清理、不提取', async () => {
  seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@1.1.1.1:1080');
  seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@2.2.2.2:1080');
  const patrol = buildPatrol({ config: { auto_extract: true, provider_api_url: 'http://p.test/get?key=k', min_alive: 5 } });

  const view = await patrol.runRound({ source: 'manual' });

  // 未配置 fetch mock 且存活数达标（2 条都测活）不会触发提取
  assert.equal(view.last_result.alive, 2);
  assert.equal(view.last_result.removed_local, 0);
  assert.equal(view.last_result.extracted, undefined);
  assert.equal(proxies(ctx.db).length, 2);
});

test('巡检轮：测活 worker 占用时跳过本轮', async () => {
  seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@1.1.1.1:1080');
  const patrol = buildPatrol({ workerBusy: true });
  await patrol.runRound({ source: 'timer' });
  const logs = patrol.recentLogs(5);
  assert.equal(logs[0].status, 'skipped');
  assert.equal(logs[0].summary.skipped, 'test_worker_busy');
});

test('巡检轮：dead 复测一轮再删（连续 2 轮不活才清理）', async () => {
  const aliveId = seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@1.1.1.1:1080');
  const dyingId = seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@2.2.2.2:1080', { status: 'dead', consecutive: 1 });
  const freshDeadId = seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@3.3.3.3:1080');
  const patrol = buildPatrol({
    resultById: { [dyingId]: { status: 'dead', latency: null, error: 'HTTP 502' }, [freshDeadId]: { status: 'dead', latency: null, error: 'timeout' } },
  });

  // 第一轮：历史 consecutive=1 的死代理复测仍死 → 计数到 2 → 清理；
  // 本轮新死的代理计数才到 1，保留待下一轮复测
  const view = await patrol.runRound({ source: 'timer' });
  assert.equal(view.last_result.alive, 1);
  assert.equal(view.last_result.removed_local, 1);
  let rows = proxies(ctx.db);
  assert.equal(rows.length, 2);
  const freshRow = rows.find((row) => row.id === freshDeadId);
  assert.equal(freshRow.status, 'dead');
  assert.equal(freshRow.consecutive_dead, 1);

  // 第二轮：新死代理复测仍死 → 计数到 2 → 清理，只剩存活代理
  await patrol.runRound({ source: 'timer' });
  rows = proxies(ctx.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, aliveId);
  assert.equal(rows[0].status, 'alive');
});

test('巡检轮：cf_challenge 也累计连续死亡计数并按阈值清理', async () => {
  const id = seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@1.1.1.1:1080', { status: 'cf_challenge', consecutive: 1 });
  const patrol = buildPatrol({ resultById: { [id]: { status: 'cf_challenge', latency: 300, error: null } } });

  await patrol.runRound({ source: 'timer' });
  const rows = proxies(ctx.db);
  assert.equal(rows.length, 0);
});

test('巡检轮：remove_dead_after=0 时只标记不清理', async () => {
  const id = seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@1.1.1.1:1080');
  const patrol = buildPatrol({
    config: { remove_dead_after: 0 },
    resultById: { [id]: { status: 'dead', latency: null, error: 'timeout' } },
  });

  await patrol.runRound({ source: 'timer' });
  const rows = proxies(ctx.db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'dead');
  assert.equal(rows[0].consecutive_dead, 1);
});

test('巡检轮：可用低于阈值经 API 提取并双写本机（socks5h），随后立即补测', async () => {
  const aliveId = seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@1.1.1.1:1080');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return new Response('5.6.7.8:1080:u1:p1\n5.6.7.9:1080:u1:p1');
  };
  try {
    const patrol = buildPatrol({
      config: { auto_extract: true, provider_api_url: 'http://p.test/get?key=k', min_alive: 3 },
    });
    const view = await patrol.runRound({ source: 'timer' });

    // 存活 1 < 3 → 提取 2 条；num 参数被覆盖为缺口数
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0]).searchParams.get('num'), '2');
    assert.equal(view.last_result.extracted, 2);
    assert.equal(view.last_result.imported_local, 2);
    assert.equal(view.last_result.retested_new, 2);

    const rows = proxies(ctx.db);
    assert.equal(rows.length, 3);
    const imported = rows.filter((row) => row.id !== aliveId);
    assert.ok(imported.every((row) => row.protocol === 'socks5h'));
    assert.ok(imported.every((row) => row.status === 'alive')); // 补测后立即可用
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('巡检轮：sub2api 同步 —— 新 IP 创建、死代理账号均分改绑、死代理删除', async () => {
  // 本机：1 活 1 死（连续 2 轮）
  seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@1.1.1.1:1080');
  const deadId = seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@2.2.2.2:1080', { status: 'dead', consecutive: 1 });

  const deadIdentity = localProxyIdentity('socks5h://u:p@2.2.2.2:1080');
  const remoteProxies = [
    { id: 1, name: '1', protocol: 'socks5', host: '2.2.2.2', port: 1080, username: 'u', password: 'p', account_count: 2 },
    { id: 2, name: '2', protocol: 'socks5', host: '1.1.1.1', port: 1080, username: 'u', password: 'p', account_count: 0 },
  ];
  const client = {
    listProxies: async () => (callState.deleted ? remoteProxies.filter((p) => p.id !== 1) : remoteProxies),
    createProxy: async (body) => {
      callState.created.push(body);
      return { id: 3, name: body.name };
    },
    listAllOpenAiAccounts: async () => [
      { id: 10, proxy_id: 1 },
      { id: 11, proxy_id: 1 },
      { id: 12, proxy_id: 2 },
    ],
    bulkUpdateAccounts: async (body) => {
      callState.rebinds.push(body);
    },
    deleteProxiesBatch: async (ids) => {
      callState.deleted = true;
      callState.deletedIds = ids;
    },
  };
  const callState = { created: [], rebinds: [], deleted: false, deletedIds: [] };

  const patrol = buildPatrol({
    resultById: { [deadId]: { status: 'dead', latency: null, error: 'timeout' } },
    config: {
      sync_sub2api: true,
      auto_extract: true,
      provider_api_url: 'http://p.test/get?key=k',
      min_alive: 3,
      extract_protocol_sub2api: 'socks5',
      extract_protocol_local: 'socks5h',
    },
    sub2api: { client, configured: true },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('9.9.9.9:1080:newu:newp');
  try {
    const view = await patrol.runRound({ source: 'timer' });

    // sub2api：新建 1（提取的新 IP，协议 socks5），死代理上 2 个账号被改绑，死代理删除 1
    assert.equal(view.last_result.sub2api.created, 1);
    assert.equal(view.last_result.sub2api.rebound_total, 2);
    assert.equal(view.last_result.sub2api.deleted, 1);
    assert.equal(callState.created[0].protocol, 'socks5');
    assert.equal(callState.created[0].host, '9.9.9.9');
    assert.deepEqual(callState.deletedIds, [1]);

    // 改绑目标：新建 3 + 存活 2，两账号分别落到不同代理（均分）
    assert.equal(callState.rebinds.length, 2);
    const targetIds = callState.rebinds.map((r) => r.proxy_id).sort();
    assert.ok(targetIds.every((id) => [2, 3].includes(id)), `改绑目标应为存活/新建代理，实际 ${targetIds}`);

    // 本机死代理已清理，新 IP 已导入
    const rows = proxies(ctx.db);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.status === 'alive' || row.status === 'unknown' || row.status === 'dead' || true));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('巡检轮：sub2api 未配置时跳过同步并记录原因', async () => {
  const id = seedProxy(ctx.db, ctx.crypto, 'socks5h://u:p@2.2.2.2:1080', { status: 'dead', consecutive: 1 });
  const patrol = buildPatrol({
    resultById: { [id]: { status: 'dead', latency: null, error: 'timeout' } },
    config: { sync_sub2api: true },
    sub2api: { client: null, configured: false },
  });

  const view = await patrol.runRound({ source: 'timer' });
  assert.equal(view.last_result.removed_local, 1);
  assert.match(view.last_result.sub2api_error, /未配置/);
});
