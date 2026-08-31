import { parsePagination } from '../../lib/db.js';
import { errors } from '../../lib/http-errors.js';
import { maskProxyUrl } from '../../lib/sanitize.js';
import { createProxySelector } from './selector.js';
import { createTestWorker } from './test-worker.js';
import { insertProxy, persistTestResult, localProxyIdentity, buildProxyUrlFromItem } from './import-helper.js';
import { createProxyPatrol } from './patrol.js';
import { buildExtractUrl } from './provider-fetch.js';
import { parseReplaceLines, proxyIdentity } from '../sub2api/proxy-replace.js';

export function createProxiesModule({ logger }) {
  return async function proxiesModule(app) {
    const db = app.db;
    const crypto = app.crypto;
    const selector = createProxySelector(db, crypto);
    const testWorker = createTestWorker({ logger });
    app.decorate('proxySelector', selector);

    const patrol = createProxyPatrol({
      db,
      crypto,
      testWorker,
      getConfig: () => app.settings.get('proxies.patrol'),
      // sub2api 模块注册在 proxies 之后，fp 装饰落根实例，巡检轮触发时必然已存在
      getSub2api: () => {
        const config = app.settings.get('sub2api.config');
        return {
          client: app.sub2apiClient,
          configured: Boolean(config?.base_url && config?.admin_key),
        };
      },
      logger,
    });
    app.decorate('proxyPatrol', patrol);

    function proxyView(row) {
      return {
        id: row.id,
        display_url: row.display_url,
        label: row.label,
        protocol: row.protocol,
        status: row.status,
        last_latency_ms: row.last_latency_ms,
        last_checked_at: row.last_checked_at,
        fail_count: row.fail_count,
        rotatable: Boolean(row.rotatable),
        last_error: row.last_error ? maskProxyUrl(row.last_error) : null,
        created_at: row.created_at,
      };
    }

    app.get('/api/v1/proxies', async (request) => {
      const { page, pageSize, offset } = parsePagination(request.query);
      const filters = [];
      const params = [];
      if (request.query.status) {
        filters.push('status = ?');
        params.push(String(request.query.status));
      }
      if (request.query.q) {
        filters.push('(label LIKE ? OR display_url LIKE ?)');
        params.push(`%${request.query.q}%`, `%${request.query.q}%`);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM proxies ${where}`).get(...params).n;
      const items = db
        .prepare(`SELECT * FROM proxies ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, offset);
      const statsRows = db.prepare(`SELECT status, COUNT(*) AS n FROM proxies GROUP BY status`).all();
      const stats = { alive: 0, dead: 0, cf_challenge: 0, unknown: 0, testing: 0 };
      for (const row of statsRows) stats[row.status] = row.n;
      return { items: items.map(proxyView), total, page, page_size: pageSize, stats };
    });

    app.post(
      '/api/v1/proxies/import',
      {
        schema: {
          body: {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: { text: { type: 'string', maxLength: 2_000_000 } },
          },
        },
      },
      async (request, reply) => {
        const lines = String(request.body.text || '').split(/\r?\n/);
        let created = 0;
        const duplicates = [];
        const invalidLines = [];
        const tx = db.transaction(() => {
          lines.forEach((rawLine, index) => {
            const line = rawLine.trim();
            if (!line || line.startsWith('#')) return;
            const [rawUrl, label] = line.split('----').map((part) => part.trim());
            const inserted = insertProxy(db, crypto, rawUrl, label || null);
            if (inserted.ok) {
              created += 1;
            } else if (inserted.duplicate) {
              duplicates.push(maskProxyUrl(inserted.url));
            } else {
              invalidLines.push({ line: index + 1, reason: inserted.reason });
            }
          });
        });
        tx();
        reply.code(201);
        return { created, duplicates, invalid_lines: invalidLines };
      },
    );

    app.post(
      '/api/v1/proxies/test',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 2000 } },
          },
        },
      },
      async (request, reply) => {
        if (testWorker.isBusy()) throw errors.conflict('已有测活批次进行中', 'TEST_RUNNING');
        const ids = Array.isArray(request.body?.ids) && request.body.ids.length
          ? request.body.ids
          : null;
        const rows = ids
          ? db.prepare(`SELECT id, url_enc FROM proxies WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
          : db.prepare(`SELECT id, url_enc FROM proxies WHERE status != 'alive'`).all();
        const targets = rows
          .map((row) => ({ id: row.id, url: crypto.tryDecrypt(row.url_enc, 'proxies.url_enc') }))
          .filter((item) => item.url);
        if (!targets.length) {
          reply.code(202);
          return { started: 0 };
        }
        const now = new Date().toISOString();
        const markTx = db.transaction(() => {
          for (const target of targets) {
            db.prepare(`UPDATE proxies SET status='testing', updated_at=? WHERE id=?`).run(now, target.id);
          }
        });
        markTx();

        // 后台执行，结果逐条落库
        void (async () => {
          try {
            await testWorker.testProxies(targets, (id, result) => {
              persistTestResult(db, id, result);
            });
          } catch (error) {
            logger.error({ err: error.message }, 'proxy test batch failed');
            db.prepare(`UPDATE proxies SET status='unknown', updated_at=? WHERE status='testing'`).run(
              new Date().toISOString(),
            );
          }
        })();

        reply.code(202);
        return { started: targets.length };
      },
    );

    // 一键更换代理 IP（合并入口）：sub2api 侧替换（协议默认 socks5，逻辑复用现有实现）
    // + 本机代理列表以 local_protocol（默认 socks5h）导入换批；两侧旧代理按开关删除
    app.post(
      '/api/v1/proxies/replace',
      {
        schema: {
          body: {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: {
              text: { type: 'string', minLength: 1, maxLength: 2_000_000 },
              sub2api_protocol: { type: 'string', enum: ['http', 'https', 'socks5', 'socks5h'] },
              local_protocol: { type: 'string', enum: ['http', 'https', 'socks5', 'socks5h'] },
              delete_old: { type: 'boolean' },
              sync_sub2api: { type: 'boolean' },
              delete_old_local: { type: 'boolean' },
            },
          },
        },
      },
      async (request) => {
        const body = request.body;
        const sub2apiProtocol = body.sub2api_protocol || 'socks5';
        const localProtocol = body.local_protocol || 'socks5h';
        const parsed = parseReplaceLines(body.text);
        if (parsed.items.length === 0) {
          throw errors.validation('没有可用的代理行，请检查输入格式');
        }

        // sub2api 侧：建新代理 + 绑旧代理的账号随机均分改绑 + 删旧代理（与 sub2api 页入口同一实现）
        let sub2api = null;
        let sub2apiSkippedReason = null;
        if (body.sync_sub2api === false) {
          sub2apiSkippedReason = '未启用 sub2api 同步';
        } else {
          const config = app.settings.get('sub2api.config');
          if (config?.base_url && config?.admin_key && app.sub2apiProxyReplace) {
            sub2api = await app.sub2apiProxyReplace({
              text: body.text,
              protocol: sub2apiProtocol,
              deleteOld: body.delete_old !== false,
            });
          } else {
            sub2apiSkippedReason = 'sub2api 未配置，已跳过远端替换（仅本机导入）';
          }
        }

        // 本机侧：以 local_protocol 导入（url_hash 去重）
        const inputIdentities = new Set(parsed.items.map((item) => proxyIdentity(item)));
        let imported = 0;
        const duplicates = [];
        const invalidLines = [...parsed.invalid_lines];
        for (const item of parsed.items) {
          const inserted = insertProxy(db, crypto, buildProxyUrlFromItem(item, localProtocol));
          if (inserted.ok) {
            imported += 1;
          } else if (inserted.duplicate) {
            duplicates.push(maskProxyUrl(inserted.url));
          } else {
            invalidLines.push({ line: 0, reason: `${item.host}:${item.port}：${inserted.reason}` });
          }
        }

        // 本机换批：删除身份不在本次输入中的旧代理（与 sub2api 换批口径一致）
        let removedLocal = 0;
        if (body.delete_old_local !== false) {
          const rows = db.prepare('SELECT id, url_enc FROM proxies').all();
          const toRemove = rows
            .map((row) => ({ id: row.id, url: crypto.tryDecrypt(row.url_enc, 'proxies.url_enc') }))
            .filter((row) => row.url && !inputIdentities.has(localProxyIdentity(row.url)));
          const tx = db.transaction(() => {
            for (const row of toRemove) {
              db.prepare('UPDATE jobs SET proxy_id = NULL WHERE proxy_id = ?').run(row.id);
              db.prepare('DELETE FROM proxies WHERE id = ?').run(row.id);
            }
          });
          tx();
          removedLocal = toRemove.length;
        }

        return {
          sub2api,
          sub2api_skipped_reason: sub2apiSkippedReason,
          local: {
            protocol: localProtocol,
            imported,
            duplicates,
            removed: removedLocal,
            invalid_lines: invalidLines,
          },
        };
      },
    );

    app.get('/api/v1/proxies/patrol', async (request) => {
      const limit = Math.min(100, Math.max(1, Number.parseInt(request.query.limit || '10', 10) || 10));
      return { ...patrol.view(), logs: patrol.recentLogs(limit) };
    });

    app.post(
      '/api/v1/proxies/patrol',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              enabled: { type: 'boolean' },
              interval_seconds: { type: 'integer' },
              remove_dead_after: { type: 'integer' },
              auto_extract: { type: 'boolean' },
              provider_api_url: { type: 'string', maxLength: 2000 },
              min_alive: { type: 'integer' },
              extract_protocol_sub2api: { type: 'string', enum: ['http', 'https', 'socks5', 'socks5h'] },
              extract_protocol_local: { type: 'string', enum: ['http', 'https', 'socks5', 'socks5h'] },
              sync_sub2api: { type: 'boolean' },
            },
          },
        },
      },
      async (request) => {
        const current = app.settings.get('proxies.patrol') || {};
        const body = request.body || {};
        const next = { ...current };
        for (const key of [
          'enabled',
          'interval_seconds',
          'remove_dead_after',
          'auto_extract',
          'min_alive',
          'extract_protocol_sub2api',
          'extract_protocol_local',
          'sync_sub2api',
        ]) {
          if (body[key] !== undefined) next[key] = body[key];
        }
        if (body.provider_api_url !== undefined) next.provider_api_url = String(body.provider_api_url).trim();

        const interval = Number(next.interval_seconds);
        if (!Number.isInteger(interval) || interval < 30 || interval > 86_400) {
          throw errors.validation('巡检间隔需在 30 秒到 24 小时之间');
        }
        const minAlive = Number(next.min_alive);
        if (!Number.isInteger(minAlive) || minAlive < 1) {
          throw errors.validation('最小可用代理数至少为 1');
        }
        const removeAfter = Number(next.remove_dead_after);
        if (!Number.isInteger(removeAfter) || removeAfter < 0) {
          throw errors.validation('连续失败自动清理的轮数不能为负');
        }
        if (next.auto_extract) {
          if (!next.provider_api_url) {
            throw errors.validation('开启自动提取前，请先填写服务商 API 提取链接');
          }
          try {
            buildExtractUrl(next.provider_api_url, 1);
          } catch (error) {
            throw errors.validation(error.message);
          }
        }

        app.settings.set('proxies.patrol', next);
        patrol.startIfEnabled();
        return patrol.view();
      },
    );

    app.post('/api/v1/proxies/patrol/check', async (request, reply) => {
      patrol.checkInBackground();
      reply.code(202);
      return { ok: true, patrol: patrol.view() };
    });

    app.patch(
      '/api/v1/proxies/:id',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { label: { type: 'string', maxLength: 200 } },
          },
        },
      },
      async (request) => {
        const id = Number(request.params.id);
        const row = db.prepare('SELECT * FROM proxies WHERE id = ?').get(id);
        if (!row) throw errors.notFound('代理不存在');
        db.prepare('UPDATE proxies SET label=?, updated_at=? WHERE id=?').run(
          request.body.label ?? row.label,
          new Date().toISOString(),
          id,
        );
        return proxyView(db.prepare('SELECT * FROM proxies WHERE id = ?').get(id));
      },
    );

    app.delete('/api/v1/proxies/:id', async (request) => {
      const id = Number(request.params.id);
      const tx = db.transaction(() => {
        // jobs.proxy_id 外键无 ON DELETE 规则，先解除引用再删
        db.prepare('UPDATE jobs SET proxy_id = NULL WHERE proxy_id = ?').run(id);
        const result = db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
        if (result.changes === 0) throw errors.notFound('代理不存在');
      });
      tx();
      return { ok: true };
    });

    app.post(
      '/api/v1/proxies/batch-delete',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 2000 } },
          },
        },
      },
      async (request) => {
        const ids = request.body.ids;
        const tx = db.transaction(() => {
          for (const id of ids) {
            db.prepare('UPDATE jobs SET proxy_id = NULL WHERE proxy_id = ?').run(id);
            db.prepare('DELETE FROM proxies WHERE id = ?').run(id);
          }
        });
        tx();
        return { deleted: ids.length };
      },
    );
  };
}
