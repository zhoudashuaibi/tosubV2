import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExtractUrl, fetchNewProxies } from '../modules/proxies/provider-fetch.js';

const TEMPLATE = 'https://apisocks.1024proxy.com/api/getIpInfo?key=abc&port=443&num=1&country=US&type=3';

test('提取链接：覆盖 num，其余参数原样保留', () => {
  const url = new URL(buildExtractUrl(TEMPLATE, 5));
  assert.equal(url.searchParams.get('num'), '5');
  assert.equal(url.searchParams.get('key'), 'abc');
  assert.equal(url.searchParams.get('country'), 'US');
  assert.equal(url.searchParams.get('type'), '3');
});

test('提取链接：num 向下取整且最小为 1', () => {
  assert.equal(new URL(buildExtractUrl(TEMPLATE, 2.9)).searchParams.get('num'), '2');
  assert.equal(new URL(buildExtractUrl(TEMPLATE, 0)).searchParams.get('num'), '1');
});

test('提取链接：非 http(s) 与非法 URL 拒绝', () => {
  assert.throws(() => buildExtractUrl('ftp://x/y', 1), /HTTP 或 HTTPS/);
  assert.throws(() => buildExtractUrl('不是链接', 1), /格式不正确/);
  assert.throws(() => buildExtractUrl('', 1), /格式不正确/);
});

/** 替换全局 fetch 为返回固定文本/状态的假实现 */
function withFetchMock(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => handler(String(input), init);
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original;
  });
}

test('提取响应：type=2 文本行 ip:port:user:pass', async () => {
  await withFetchMock(
    () => new Response('1.2.3.4:8080:u1:p1\n5.6.7.8:1080:u2:p2\n'),
    async () => {
      const { items } = await fetchNewProxies(TEMPLATE, 2);
      assert.equal(items.length, 2);
      assert.deepEqual(items[0], { host: '1.2.3.4', port: 8080, username: 'u1', password: 'p1' });
    },
  );
});

test('提取响应：type=3 文本行 user:pass@ip:port', async () => {
  await withFetchMock(
    () => new Response('u1:p1@1.2.3.4:8080\r\n'),
    async () => {
      const { items } = await fetchNewProxies(TEMPLATE, 1);
      assert.deepEqual(items[0], { host: '1.2.3.4', port: 8080, username: 'u1', password: 'p1' });
    },
  );
});

test('提取响应：type=1 无认证 ip:port', async () => {
  await withFetchMock(
    () => new Response('1.2.3.4:8080'),
    async () => {
      const { items } = await fetchNewProxies(TEMPLATE, 1);
      assert.deepEqual(items[0], { host: '1.2.3.4', port: 8080, username: null, password: null });
    },
  );
});

test('提取响应：JSON {data:[字符串]}', async () => {
  await withFetchMock(
    () => new Response(JSON.stringify({ code: 0, data: ['1.2.3.4:8080:u:p'] }), { headers: { 'content-type': 'application/json' } }),
    async () => {
      const { items } = await fetchNewProxies(TEMPLATE, 1);
      assert.equal(items.length, 1);
      assert.equal(items[0].host, '1.2.3.4');
    },
  );
});

test('提取响应：JSON 数组对象 ip/port/username/password 字段', async () => {
  await withFetchMock(
    () => new Response(JSON.stringify([{ ip: '1.2.3.4', port: 8080, username: 'u', password: 'p' }])),
    async () => {
      const { items } = await fetchNewProxies(TEMPLATE, 1);
      assert.deepEqual(items[0], { host: '1.2.3.4', port: 8080, username: 'u', password: 'p' });
    },
  );
});

test('提取响应：错误文本（如余额不足）抛错并附响应片段', async () => {
  await withFetchMock(
    () => new Response('余额不足，请充值后重试'),
    async () => {
      await assert.rejects(() => fetchNewProxies(TEMPLATE, 1), /余额不足/);
    },
  );
});

test('提取响应：HTTP 非 2xx 抛错', async () => {
  await withFetchMock(
    () => new Response(' Forbidden', { status: 403 }),
    async () => {
      await assert.rejects(() => fetchNewProxies(TEMPLATE, 1), /HTTP 403/);
    },
  );
});

test('提取响应：空响应抛错', async () => {
  await withFetchMock(
    () => new Response('  \n'),
    async () => {
      await assert.rejects(() => fetchNewProxies(TEMPLATE, 1), /空响应/);
    },
  );
});
