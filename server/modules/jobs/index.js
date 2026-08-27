import fs from 'node:fs';
import path from 'node:path';
import { parsePagination } from '../../lib/db.js';
import { errors } from '../../lib/http-errors.js';

export function createJobsModule({ engine }) {
  return async function jobsModule(app) {
    const db = app.db;

    function jobView(row) {
      const account = row.account_id
        ? db.prepare('SELECT email FROM accounts WHERE id = ?').get(row.account_id)
        : null;
      const proxy = row.proxy_id
        ? db.prepare('SELECT display_url FROM proxies WHERE id = ?').get(row.proxy_id)
        : null;
      const active = ['queued', 'running', 'awaiting_input'].includes(row.status);
      return {
        id: row.id,
        account_id: row.account_id,
        email: account?.email ?? null,
        type: row.type,
        status: row.status,
        stage: row.stage,
        prompt_kind: row.prompt_kind,
        attempt: row.attempt,
        proxy_id: row.proxy_id,
        // 本机代理（proxy_id join）优先；余额任务走 sub2api 绑定代理时记录在 proxy_label
        proxy_display: proxy?.display_url ?? row.proxy_label ?? null,
        error: row.error,
        created_at: row.created_at,
        started_at: row.started_at,
        finished_at: row.finished_at,
        has_result: Boolean(row.result_path),
        can_cancel: active,
        can_retry: !active,
        can_input: row.status === 'awaiting_input',
      };
    }

    app.get('/api/v1/jobs', async (request) => {
      const { page, pageSize, offset } = parsePagination(request.query);
      const filters = [];
      const params = [];
      if (request.query.status) {
        filters.push('status = ?');
        params.push(String(request.query.status));
      }
      if (request.query.type) {
        filters.push('type = ?');
        params.push(String(request.query.type));
      }
      if (request.query.account_id) {
        filters.push('account_id = ?');
        params.push(Number(request.query.account_id));
      }
      if (request.query.q) {
        filters.push('account_id IN (SELECT id FROM accounts WHERE email LIKE ?)');
        params.push(`%${String(request.query.q)}%`);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs ${where}`).get(...params).n;
      const items = db
        .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, offset)
        .map(jobView);
      const stats = {
        queued: db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='queued'`).get().n,
        running: db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='running'`).get().n,
        awaiting_input: db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='awaiting_input'`).get().n,
      };
      return { items, total, page, page_size: pageSize, stats };
    });

    app.get('/api/v1/jobs/:id', async (request) => {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(request.params.id);
      if (!row) throw errors.notFound('任务不存在');
      const view = jobView(row);
      view.has_result =
        (row.result_path && fs.existsSync(path.resolve(app.config.dataDir, row.result_path))) ||
        (row.result_path && fs.existsSync(row.result_path)) ||
        fs.existsSync(path.resolve(app.config.dataDir, 'results', `${row.id}.json`));
      view.can_download = view.has_result && row.status === 'completed';
      if (view.can_download) view.result_path = row.result_path || `results/${row.id}.json`;
      view.checkpoint_path = row.checkpoint_path;
      view.totp_result_path = row.totp_result_path;
      return view;
    });

    app.get('/api/v1/jobs/:id/logs', async (request) => {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(request.params.id);
      if (!row) throw errors.notFound('任务不存在');
      const logPath = path.resolve(app.config.dataDir, row.log_path);
      const after = Math.max(0, Number.parseInt(request.query.after || '0', 10) || 0);
      const limit = Math.min(256 * 1024, Math.max(1024, Number.parseInt(request.query.limit || '65536', 10) || 65536));
      let chunk = '';
      let nextOffset = after;
      let eof = true;
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > after) {
          const fd = fs.openSync(logPath, 'r');
          try {
            const length = Math.min(limit, stat.size - after);
            const buffer = Buffer.alloc(length);
            fs.readSync(fd, buffer, 0, length, after);
            chunk = buffer.toString('utf8');
            nextOffset = after + length;
          } finally {
            fs.closeSync(fd);
          }
        }
        eof = nextOffset >= stat.size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return { chunk, next_offset: nextOffset, eof };
    });

    app.get('/api/v1/jobs/:id/result', async (request, reply) => {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(request.params.id);
      if (!row) throw errors.notFound('任务不存在');
      const candidates = [
        row.result_path && path.resolve(app.config.dataDir, row.result_path),
        path.resolve(app.config.dataDir, 'results', `${row.id}.json`),
      ].filter(Boolean);
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) throw errors.notFound('任务产物不存在');
      reply.header('content-type', 'application/json');
      reply.header('content-disposition', `attachment; filename="${row.id}.json"`);
      return reply.send(fs.createReadStream(found));
    });

    app.post(
      '/api/v1/jobs/:id/input',
      {
        schema: {
          body: {
            type: 'object',
            required: ['action'],
            additionalProperties: false,
            properties: {
              action: { type: 'string', enum: ['input', 'resend', 'quit'] },
              value: { type: 'string', maxLength: 512 },
            },
          },
        },
      },
      async (request) => {
        return engine.submitInput(request.params.id, request.body.action, request.body.value);
      },
    );

    app.post('/api/v1/jobs/:id/cancel', async (request) => {
      const job = await engine.cancel(request.params.id);
      return { job: jobView(job) };
    });

    app.post('/api/v1/jobs/:id/retry', async (request, reply) => {
      const proxyId = request.body?.proxy_id ? Number(request.body.proxy_id) : null;
      const job = engine.retry(request.params.id, { proxyId });
      reply.code(202);
      return { job: jobView(job) };
    });

    app.post('/api/v1/jobs/cancel-all', async () => {
      const canceled = await engine.cancelAll();
      return { canceled };
    });
  };
}
