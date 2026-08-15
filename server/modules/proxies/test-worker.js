import { TlsFingerprintTransport } from '../../core/tls-transport.mjs';
import { isRiskControlResponse } from '../../core/risk-control.mjs';

const TEST_CONCURRENCY = 5;
const TEST_TIMEOUT_MS = 15_000;

/**
 * 短生命周期测活 worker：每批最多 5 个独立 TLS transport 实例（各带一个 Python 子进程），
 * 测完即 close。判定口径与登录预检 prepareProxy 一致。
 */
export function createTestWorker({ logger }) {
  let running = false;

  async function testProxies(proxies, onResult) {
    if (running) throw new Error('BUSY');
    running = true;
    const queue = [...proxies];
    try {
      await Promise.all(
        Array.from({ length: Math.min(TEST_CONCURRENCY, queue.length) }, async () => {
          const transport = new TlsFingerprintTransport({ enabled: true, profile: 'chrome146' });
          try {
            while (queue.length) {
              const proxy = queue.shift();
              const t0 = Date.now();
              try {
                await transport.configure(proxy.url, { force: true });
                const res = await transport.request('GET', 'https://chatgpt.com/', {
                  timeoutMs: TEST_TIMEOUT_MS,
                  discardBody: false,
                });
                const latency = Date.now() - t0;
                const text = await res.text();
                const status = isRiskControlResponse(res, text)
                  ? 'cf_challenge'
                  : res.status < 400
                    ? 'alive'
                    : 'dead';
                onResult(proxy.id, {
                  status,
                  latency,
                  error: status === 'dead' ? `HTTP ${res.status}` : null,
                });
              } catch (error) {
                onResult(proxy.id, {
                  status: 'dead',
                  latency: null,
                  error: String(error?.message || error).slice(0, 300),
                });
              }
            }
          } finally {
            await transport.close().catch(() => {});
          }
        }),
      );
    } finally {
      running = false;
    }
  }

  return { testProxies, isBusy: () => running };
}
