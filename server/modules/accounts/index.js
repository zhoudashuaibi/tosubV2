import fs from 'node:fs';
import path from 'node:path';
import { parsePagination } from '../../lib/db.js';
import { errors } from '../../lib/http-errors.js';
import { createPools } from './pools.js';
import { parseImportLines, credentialsForImport } from './import.js';
import { createMailInit } from './mail-init.js';
import { createBanMailCheck } from './ban-mail-check.js';
import { sanitizeText } from '../../lib/sanitize.js';

const POOLS = ['reserve', 'main', 'discard'];
const SORT_WHITELIST = {
  reserve: { created_at: 'created_at', email: 'email', imported_at: 'imported_at', balance: 'initial_balance' },
  main: {
    created_at: 'created_at',
    email: 'email',
    balance: 'balance',
    last_login_at: 'last_login_at',
    sub2api_uploaded_at: 'sub2api_uploaded_at',
  },
  discard: { created_at: 'created_at', email: 'email', discarded_at: 'discarded_at' },
};

export function createAccountsModule({ engine, logger }) {
  return async function accountsModule(app) {
    const db = app.db;
    const crypto = app.crypto;
    const pools = createPools(db, crypto);
    const mailInit = createMailInit({
      db,
      getEndpoint: () => app.settings.get('outlook.fetch').endpoint,
      decryptCredentials: (account) => crypto.tryDecryptJson(account.credentials_enc, 'accounts.credentials_enc'),
      logger,
    });
    const banMailCheck = createBanMailCheck({
      db,
      getEndpoint: () => app.settings.get('outlook.fetch').endpoint,
      decryptCredentials: (account) => crypto.tryDecryptJson(account?.credentials_enc, 'accounts.credentials_enc'),
      logger,
    });

    const decryptCredentials = (account) =>
      crypto.tryDecryptJson(account?.credentials_enc, 'accounts.credentials_enc') || {};

    // 引擎回调：登录任务终态 → 池流转
    engine.hooks.onLoginFinished = (job, account, { ok, code, message, canceled }) => {
      if (!job?.account_id) return;
      try {
        if (canceled) {
          // 用户放弃：回池但不算失败
          if (account?.pool === 'reserve') {
            db.prepare(
              `UPDATE accounts SET status='mail_failed', mail_error='任务已取消', updated_at=? WHERE id=? AND pool='reserve' AND status='joining'`,
            ).run(new Date().toISOString(), job.account_id);
          } else {
            db.prepare(
              `UPDATE accounts SET status='needs_reauth', updated_at=? WHERE id=? AND pool='main' AND status='authorizing'`,
            ).run(new Date().toISOString(), job.account_id);
          }
          return;
        }
        if (ok) {
          // join 成功后异步补查余额（任务已终态，不会触发同账号活跃任务唯一索引冲突）
          try {
            const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(job.account_id);
            if (account?.pool === 'main' && account.balance == null) {
              engine.submitJob({ accountId: job.account_id, type: 'balance', note: 'join 成功后自动查余额' });
            }
          } catch (error) {
            logger.warn({ accountId: job.account_id, err: error.message }, 'auto balance job submit failed');
          }
          return;
        }
        pools.joinFailed(job.account_id, {
          error: message || code || '登录失败',
          jobId: job.id,
          permanent: /login_failed_permanent/.test(code || ''),
        });
      } catch (error) {
        logger.warn({ accountId: job.account_id, err: error.message }, 'onLoginFinished hook failed');
      }
    };

    engine.hooks.onTokensSaved = (job, runtime, tokens) => {
      if (!job?.account_id) return;
      try {
        // 转池必须最先执行：余额补查等派生任务一律延迟到 onLoginFinished（任务终态后），
        // 否则同账号活跃任务唯一索引冲突会把整个转池中断
        const result = pools.joinSucceeded(job.account_id, {
          tokensEnc: crypto.encryptJson(tokens, 'accounts.tokens_enc'),
          balance: null,
          balanceCheckedAt: null,
        });
        // 登录最终成功后删 checkpoint（token 已入库）
        const checkpointPath = path.resolve(app.config.dataDir, 'checkpoints', String(job.account_id), 'login.json');
        fs.rmSync(checkpointPath, { force: true });
        // 可选：新加入主号池后自动上传 sub2api
        const sub2apiConfig = app.settings.get('sub2api.config');
        if (sub2apiConfig?.join_auto_upload && !result.reauth) {
          app.sub2apiUploader?.uploadAccounts([job.account_id], {}).catch((error) =>
            logger.warn({ err: error.message }, 'join_auto_upload failed'),
          );
        }
      } catch (error) {
        logger.error({ accountId: job.account_id, err: error.message }, 'onTokensSaved hook failed');
      }
    };

    engine.hooks.onPermanentFailure = (job, runtime, message) => {
      if (!job?.account_id) return;
      try {
        pools.moveToDiscard(job.account_id, 'login_failed', message, { fromPools: ['reserve', 'main'] });
      } catch (error) {
        logger.warn({ err: error.message }, 'onPermanentFailure hook failed');
      }
      // 邮箱辅证：拉封禁邮件比对（异步，不阻塞任务终态流转）
      Promise.resolve(banMailCheck.check(job.account_id, { source: 'login_permanent_failure' })).catch(() => {});
    };

    // ---------------- 列表 ----------------
    app.get('/api/v1/accounts', async (request) => {
      const pool = String(request.query.pool || '');
      if (!POOLS.includes(pool)) throw errors.validation('pool 必须是 reserve / main / discard');
      const { page, pageSize, offset } = parsePagination(request.query);
      const filters = ['pool = ?'];
      const params = [pool];
      if (request.query.q) {
        filters.push('email LIKE ?');
        params.push(`%${String(request.query.q)}%`);
      }
      if (request.query.status) {
        filters.push('status = ?');
        params.push(String(request.query.status));
      }
      if (request.query.banned === 'true' || request.query.banned === '1') filters.push('banned = 1');
      if (request.query.banned === 'false' || request.query.banned === '0') filters.push('banned = 0');
      if (request.query.has_balance === 'true') filters.push('has_balance = 1');

      const sortKey = String(request.query.sort || 'created_at').replace(/:(asc|desc)$/i, '');
      const sortDir = /:desc$/i.test(String(request.query.sort || '')) ? 'DESC' : 'ASC';
      const sortColumn = SORT_WHITELIST[pool][sortKey] || 'created_at';

      const where = `WHERE ${filters.join(' AND ')}`;
      const total = db.prepare(`SELECT COUNT(*) AS n FROM accounts ${where}`).get(...params).n;
      const rows = db
        .prepare(`SELECT * FROM accounts ${where} ORDER BY ${sortColumn} ${sortDir}, id DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, offset);
      return {
        items: rows.map((row) => accountView(row, pool)),
        total,
        page,
        page_size: pageSize,
        stats: poolStats(pool),
      };
    });

    function accountView(row, pool) {
      const base = { id: row.id, email: row.email, pool: row.pool, status: row.status, note: row.note };
      if (pool === 'reserve') {
        return {
          ...base,
          initial_balance: row.initial_balance,
          has_balance: Boolean(row.has_balance),
          banned: Boolean(row.banned),
          banned_reason: row.banned_reason,
          mail_status: row.mail_status,
          mail_error: row.mail_error ? sanitizeText(row.mail_error) : null,
          imported_at: row.imported_at,
          last_checked_at: row.last_checked_at,
        };
      }
      if (pool === 'main') {
        const tokens = row.tokens_enc ? crypto.tryDecryptJson(row.tokens_enc, 'accounts.tokens_enc') : null;
        const credentials = decryptCredentials(row);
        return {
          ...base,
          balance: row.balance,
          balance_checked_at: row.balance_checked_at,
          balance_error: row.balance_error ? sanitizeText(row.balance_error) : null,
          last_login_at: row.last_login_at,
          sub2api_account_id: row.sub2api_account_id,
          sub2api_uploaded_at: row.sub2api_uploaded_at,
          remote_status: row.sub2api_account_id ? (row.status === 'active' ? 'active' : row.status) : null,
          has_refresh_token: Boolean(tokens?.refresh_token),
          has_password: Boolean(credentials?.password),
          has_totp: Boolean(credentials?.totp_secret),
          auto_repair_blocked: Boolean(row.auto_repair_blocked),
        };
      }
      return {
        ...base,
        discard_reason: row.discard_reason,
        discard_detail: row.discard_detail ? sanitizeText(row.discard_detail) : null,
        balance: row.balance,
        banned: Boolean(row.banned),
        discarded_at: row.discarded_at,
      };
    }

    function poolStats(pool) {
      if (pool === 'reserve') {
        const rows = db
          .prepare(
            `SELECT status, COUNT(*) AS n, SUM(banned) AS banned FROM accounts WHERE pool='reserve' GROUP BY status`,
          )
          .all();
        const stats = {};
        for (const row of rows) stats[row.status] = row.n;
        stats.banned = rows.reduce((sum, row) => sum + (row.banned || 0), 0);
        return stats;
      }
      if (pool === 'main') {
        const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM accounts WHERE pool='main' GROUP BY status`).all();
        const stats = {};
        for (const row of rows) stats[row.status] = row.n;
        const aggregate = db
          .prepare(
            `SELECT COALESCE(SUM(balance),0) AS total_balance,
                    SUM(CASE WHEN sub2api_account_id IS NOT NULL THEN 1 ELSE 0 END) AS uploaded
             FROM accounts WHERE pool='main'`,
          )
          .get();
        stats.total_balance = Number(aggregate.total_balance || 0);
        stats.uploaded = Number(aggregate.uploaded || 0);
        return stats;
      }
      const rows = db
        .prepare(`SELECT discard_reason, COUNT(*) AS n FROM accounts WHERE pool='discard' GROUP BY discard_reason`)
        .all();
      const stats = {};
      for (const row of rows) stats[row.discard_reason || 'manual'] = row.n;
      return stats;
    }

    // ---------------- 导入（备用池） ----------------
    app.post(
      '/api/v1/accounts/import',
      {
        schema: {
          body: {
            type: 'object',
            required: ['text'],
            additionalProperties: false,
            properties: {
              text: { type: 'string', maxLength: 2_000_000 },
              force_discard: { type: 'boolean' },
              force_remote: { type: 'boolean' },
            },
          },
        },
      },
      async (request, reply) => {
        const { text, force_discard = false, force_remote = false } = request.body;
        const parsed = parseImportLines(text);
        const invalidLines = parsed.filter((r) => !r.ok && !r.duplicateInBatch).map(({ line, reason }) => ({ line, reason }));
        const duplicatesInBatch = [...new Set(parsed.filter((r) => r.duplicateInBatch).map((r) => r.email))];

        const good = parsed.filter((r) => r.ok);
        const duplicatesInReserve = [];
        const duplicatesInMain = [];
        const duplicatesInDiscard = [];
        const duplicatesRemote = [];
        const created = [];

        // 远端 sub2api 查重（已配置且可连通才检查）
        let remoteEmails = null;
        const sub2apiConfig = app.settings.get('sub2api.config');
        if (sub2apiConfig?.base_url && sub2apiConfig?.admin_key && app.sub2apiClient) {
          try {
            const accounts = await app.sub2apiClient.listAllOpenAiAccounts();
            remoteEmails = new Set(accounts.map((a) => app.sub2apiClient.accountEmail(a)).filter(Boolean));
          } catch (error) {
            logger.warn({ err: sanitizeText(String(error.message)) }, 'remote dedup check failed');
          }
        }

        const insertTx = db.transaction(() => {
          for (const entry of good) {
            const existing = db
              .prepare('SELECT id, pool, discard_reason FROM accounts WHERE email = ? COLLATE NOCASE')
              .get(entry.email);
            if (existing) {
              if (existing.pool === 'reserve') {
                duplicatesInReserve.push(entry.email);
                // 更新凭据（同 v1 语义：重复导入即刷新凭据）
                const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(existing.id);
                db.prepare('UPDATE accounts SET credentials_enc = ?, updated_at = ? WHERE id = ?').run(
                  crypto.encryptJson({ ...decryptCredentials(account), ...credentialsForImport(entry) }, 'accounts.credentials_enc'),
                  new Date().toISOString(),
                  existing.id,
                );
                continue;
              }
              if (existing.pool === 'main') {
                duplicatesInMain.push(entry.email);
                continue;
              }
              if (existing.pool === 'discard') {
                if (!force_discard) {
                  duplicatesInDiscard.push({ email: entry.email, reason: existing.discard_reason || 'manual' });
                  continue;
                }
                // force：清废弃记录重新入备用池
                db.prepare(
                  `UPDATE accounts SET pool='reserve', status='mail_pending', credentials_enc=?,
                     discard_reason=NULL, discard_detail=NULL, discarded_at=NULL,
                     banned=0, banned_reason=NULL, mail_status='pending', mail_error=NULL,
                     imported_at=?, updated_at=? WHERE id=?`,
                ).run(
                  crypto.encryptJson(credentialsForImport(entry), 'accounts.credentials_enc'),
                  new Date().toISOString(),
                  new Date().toISOString(),
                  existing.id,
                );
                pools.recordEvent(existing.id, 'imported', { source: 'manual', force: 'discard' });
                created.push({ id: existing.id, email: entry.email, status: 'mail_pending' });
                continue;
              }
            }
            if (remoteEmails?.has(entry.email) && !force_remote) {
              duplicatesRemote.push(entry.email);
              continue;
            }
            const now = new Date().toISOString();
            const result = db
              .prepare(
                `INSERT INTO accounts(email, pool, status, credentials_enc, mail_status, imported_at, created_at, updated_at)
                 VALUES(?, 'reserve', 'mail_pending', ?, 'pending', ?, ?, ?)
                 ON CONFLICT(email) DO NOTHING`,
              )
              .run(
                entry.email,
                crypto.encryptJson(credentialsForImport(entry), 'accounts.credentials_enc'),
                now,
                now,
                now,
              );
            if (result.changes === 0) continue;
            const id = Number(result.lastInsertRowid);
            pools.recordEvent(id, 'imported', { source: 'manual' });
            created.push({ id, email: entry.email, status: 'mail_pending' });
          }
        });
        insertTx();

        // 异步邮件初始化
        if (created.length) mailInit.enqueue(created.map((c) => c.id), { source: 'import' });

        reply.code(201);
        return {
          created: created.length,
          accounts: created,
          duplicates_in_batch: duplicatesInBatch,
          duplicates_in_reserve: duplicatesInReserve,
          duplicates_in_main: duplicatesInMain,
          duplicates_in_discard: duplicatesInDiscard,
          duplicates_remote: duplicatesRemote,
          invalid_lines: invalidLines,
        };
      },
    );

    // ---------------- 单账号手动添加（进主号池，v1 兼容） ----------------
    app.post(
      '/api/v1/accounts',
      {
        schema: {
          body: {
            type: 'object',
            required: ['email'],
            additionalProperties: false,
            properties: {
              email: { type: 'string', maxLength: 320 },
              password: { type: 'string', maxLength: 512 },
              mail_api_url: { type: 'string', maxLength: 2048 },
              totp_secret: { type: 'string', maxLength: 256 },
              phone: { type: 'string', maxLength: 32 },
              outlook: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  password: { type: 'string', maxLength: 512 },
                  client_id: { type: 'string', maxLength: 64 },
                  refresh_token: { type: 'string', maxLength: 4096 },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const body = request.body;
        const email = String(body.email || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw errors.validation('邮箱格式错误');
        const credentials = {};
        if (body.password) credentials.password = body.password;
        if (body.mail_api_url) credentials.mail_api_url = body.mail_api_url;
        if (body.totp_secret) credentials.totp_secret = body.totp_secret;
        if (body.phone) credentials.phone = body.phone;
        if (body.outlook?.refresh_token) credentials.outlook = body.outlook;
        if (!Object.keys(credentials).length) throw errors.validation('凭据至少提供一项');

        const existing = db.prepare('SELECT id, pool FROM accounts WHERE email = ? COLLATE NOCASE').get(email);
        if (existing) throw errors.conflict('账号已存在', 'ACCOUNT_STATE_INVALID');

        const now = new Date().toISOString();
        let accountId;
        const tx = db.transaction(() => {
          const result = db
            .prepare(
              `INSERT INTO accounts(email, pool, status, credentials_enc, last_login_at, created_at, updated_at)
               VALUES(?, 'main', 'authorizing', ?, NULL, ?, ?)`,
            )
            .run(email, crypto.encryptJson(credentials, 'accounts.credentials_enc'), now, now);
          accountId = Number(result.lastInsertRowid);
          pools.recordEvent(accountId, 'imported', { source: 'manual-main' });
        });
        tx();
        const job = engine.submitJob({ accountId, type: 'login', note: '手动添加账号' });
        reply.code(201);
        return {
          account: accountView(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId), 'main'),
          job_id: job.id,
        };
      },
    );

    // ---------------- refresh-mail ----------------
    app.post('/api/v1/accounts/:id/refresh-mail', async (request) => {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(Number(request.params.id));
      if (!account) throw errors.notFound('账号不存在');
      if (account.pool !== 'reserve') throw errors.accountState('仅备用号池账号可刷新邮件状态');
      mailInit.enqueue([account.id], { source: 'manual' });
      return { ok: true };
    });

    // ---------------- join-main ----------------
    app.post(
      '/api/v1/accounts/join-main',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: {
              ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 },
            },
          },
        },
      },
      async (request, reply) => {
        const started = [];
        const skipped = [];
        for (const id of request.body.ids) {
          const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
          if (!account || account.pool !== 'reserve') {
            skipped.push({ id, reason: 'ACCOUNT_STATE_INVALID' });
            continue;
          }
          if (account.status === 'joining') {
            skipped.push({ id, reason: 'CONFLICT' });
            continue;
          }
          if (account.banned) {
            skipped.push({ id, reason: 'banned' });
            continue;
          }
          const credentials = decryptCredentials(account);
          if (!credentials.outlook?.refresh_token) {
            skipped.push({ id, reason: '缺少 Outlook 取件凭据' });
            continue;
          }
          const now = new Date().toISOString();
          const tx = db.transaction(() => {
            const cas = db
              .prepare(
                `UPDATE accounts SET status='joining', updated_at=? WHERE id=? AND pool='reserve' AND status != 'joining'`,
              )
              .run(now, id);
            if (cas.changes === 0) throw errors.conflict('账号已在加入队列', 'ACCOUNT_STATE_INVALID');
            pools.recordEvent(id, 'join_started', {});
            engine.submitJob({ accountId: id, type: 'login', note: 'join-main' });
          });
          try {
            tx();
            started.push(id);
          } catch (error) {
            skipped.push({ id, reason: error.code === 'ACCOUNT_STATE_INVALID' ? 'CONFLICT' : error.message });
          }
        }
        reply.code(202);
        return { started, skipped };
      },
    );

    // ---------------- batch-authorize ----------------
    app.post(
      '/api/v1/accounts/batch-authorize',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 } },
          },
        },
      },
      async (request, reply) => {
        const started = [];
        const skipped = [];
        for (const id of request.body.ids) {
          const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
          if (!account || account.pool !== 'main') {
            skipped.push({ id, reason: '账号不在主号池' });
            continue;
          }
          if (!['active', 'needs_reauth', 'authorizing'].includes(account.status)) {
            skipped.push({ id, reason: 'ACCOUNT_STATE_INVALID' });
            continue;
          }
          const tokens = account.tokens_enc
            ? crypto.tryDecryptJson(account.tokens_enc, 'accounts.tokens_enc')
            : null;
          const credentials = decryptCredentials(account);
          let type = null;
          if (tokens?.refresh_token) type = 'refresh';
          else if (credentials.password || credentials.outlook?.refresh_token || credentials.mail_api_url) type = 'login';
          if (!type) {
            skipped.push({ id, reason: '凭据不全' });
            continue;
          }
          const now = new Date().toISOString();
          const tx = db.transaction(() => {
            const cas = db
              .prepare(
                `UPDATE accounts SET status='authorizing', updated_at=? WHERE id=? AND pool='main' AND status IN ('active','needs_reauth')`,
              )
              .run(now, id);
            if (cas.changes === 0) throw errors.conflict('账号已被占用', 'ACCOUNT_STATE_INVALID');
            engine.submitJob({ accountId: id, type, note: 'batch-authorize' });
          });
          try {
            tx();
            started.push(id);
          } catch (error) {
            skipped.push({ id, reason: 'CONFLICT' });
          }
        }
        reply.code(202);
        return { started: started.length, skipped };
      },
    );

    // ---------------- batch-refresh-balance ----------------
    app.post(
      '/api/v1/accounts/batch-refresh-balance',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 1000 } },
          },
        },
      },
      async (request, reply) => {
        const ids = Array.isArray(request.body?.ids) && request.body.ids.length
          ? request.body.ids
          : db.prepare(`SELECT id FROM accounts WHERE pool='main' AND tokens_enc IS NOT NULL`).all().map((r) => r.id);
        let started = 0;
        for (const id of ids) {
          const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
          if (!account || account.pool !== 'main' || !account.tokens_enc) continue;
          const active = db
            .prepare(`SELECT id FROM jobs WHERE account_id=? AND status IN ('queued','running','awaiting_input') AND type='balance'`)
            .get(id);
          if (active) continue;
          try {
            engine.submitJob({ accountId: id, type: 'balance', note: 'batch-refresh-balance' });
            started += 1;
          } catch (error) {
            logger.warn({ accountId: id, err: error.message }, 'submit balance job failed');
          }
        }
        reply.code(202);
        return { started };
      },
    );

    // ---------------- batch-upload-sub2api ----------------
    app.post(
      '/api/v1/accounts/batch-upload-sub2api',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: {
              ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 },
              options: { type: 'object' },
            },
          },
        },
      },
      async (request) => {
        const { ids, options } = request.body;
        const valid = ids.filter((id) => {
          const account = db.prepare('SELECT tokens_enc FROM accounts WHERE id = ? AND pool = ?').get(id, 'main');
          return Boolean(account?.tokens_enc);
        });
        if (!valid.length) throw errors.validation('所选账号均不在主号池或缺少 OAuth tokens');
        const result = await app.sub2apiUploader.uploadAccounts(valid, options || {});
        return result;
      },
    );

    // ---------------- discard / restore / delete ----------------
    app.post(
      '/api/v1/accounts/batch-discard',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: {
              ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 },
              detail: { type: 'string', maxLength: 500 },
            },
          },
        },
      },
      async (request) => {
        let discarded = 0;
        for (const id of request.body.ids) {
          try {
            pools.moveToDiscard(id, 'manual', request.body.detail || '手动废弃', { fromPools: ['main', 'reserve'] });
            discarded += 1;
          } catch (error) {
            logger.debug({ accountId: id }, `discard skipped: ${error.message}`);
          }
        }
        return { discarded };
      },
    );

    app.post('/api/v1/accounts/:id/restore', async (request) => {
      const id = Number(request.params.id);
      try {
        const result = pools.restore(id);
        return { ok: true, status: result.status };
      } catch (error) {
        throw errors.poolTransferConflict('账号不在废弃号池');
      }
    });

    app.post(
      '/api/v1/accounts/batch-delete',
      {
        schema: {
          body: {
            type: 'object',
            required: ['ids'],
            additionalProperties: false,
            properties: { ids: { type: 'array', items: { type: 'integer' }, maxItems: 500 } },
          },
        },
      },
      async (request) => {
        let deleted = 0;
        const tx = db.transaction(() => {
          for (const id of request.body.ids) {
            const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
            if (!account) continue;
            db.prepare('UPDATE jobs SET account_id = NULL WHERE account_id = ?').run(id);
            db.prepare('DELETE FROM account_events WHERE account_id = ?').run(id);
            db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
            fs.rmSync(path.resolve(app.config.dataDir, 'checkpoints', String(id)), { recursive: true, force: true });
            try {
              fs.rmSync(path.resolve(app.config.dataDir, 'results', `account-${id}.json`), { force: true });
            } catch {}
            deleted += 1;
          }
        });
        tx();
        return { deleted };
      },
    );

    // ---------------- export ----------------
    app.get('/api/v1/accounts/export', async (request, reply) => {
      const format = String(request.query.format || 'sub2api');
      const ids = String(request.query.ids || '')
        .split(',')
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v > 0);
      if (!ids.length) throw errors.validation('ids 不能为空');
      const placeholders = ids.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM accounts WHERE id IN (${placeholders})`).all(...ids);

      if (format === 'source') {
        const lines = rows.map((row) => {
          const credentials = decryptCredentials(row);
          const parts = [
            row.email,
            credentials.password || credentials.outlook?.password || '',
            credentials.mail_api_url || credentials.outlook?.client_id || '',
            credentials.totp_secret || credentials.outlook?.refresh_token || '',
          ];
          return parts.join('----');
        });
        reply.header('content-type', 'text/plain; charset=utf-8');
        reply.header('content-disposition', 'attachment; filename="accounts-source.txt"');
        return `${lines.join('\n')}\n`;
      }

      // sub2api 格式：合并各账号导出文件
      const accounts = [];
      for (const row of rows) {
        const exportPath = path.resolve(app.config.dataDir, 'results', `account-${row.id}.json`);
        if (!fs.existsSync(exportPath)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
          if (Array.isArray(data?.accounts)) accounts.push(...data.accounts);
        } catch {}
      }
      const payload = {
        type: 'sub2api-data',
        version: 1,
        exported_at: new Date().toISOString(),
        proxies: [],
        accounts,
      };
      reply.header('content-type', 'application/json');
      reply.header('content-disposition', 'attachment; filename="sub2api-import.json"');
      return payload;
    });

    // ---------------- events ----------------
    app.get('/api/v1/accounts/:id/events', async (request) => {
      const id = Number(request.params.id);
      const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
      if (!account) throw errors.notFound('账号不存在');
      const rows = db
        .prepare('SELECT type, detail, created_at FROM account_events WHERE account_id = ? ORDER BY created_at DESC LIMIT 200')
        .all(id);
      return {
        items: rows.map((row) => {
          let detail = row.detail;
          try {
            detail = JSON.parse(row.detail);
          } catch {}
          return { type: row.type, detail, created_at: row.created_at };
        }),
      };
    });

    app.decorate('accountsPools', pools);
    app.decorate('accountsMailInit', mailInit);
  };
}
