import { sanitizeText } from '../../lib/sanitize.js';

/**
 * sub2api 监控巡检（默认 5 分钟一轮）：
 *  - 只监控 OAuth 授权号（本系统上传的 free 号，type=oauth）；API Key 号（plus/pro/team 等）完全忽略
 *  - 拉全量监控分组账号 → error 账号分类（banned/rate_limit/临时错误）
 *  - OAuth 号限流不写 status=error，用 rate_limited_at 判定：重置时间超过阈值 → 移废弃池，否则保留观察
 *  - banned_401 / rate_limited_429 → 移废弃池（可选 pause 远端）
 *  - 临时错误 → 自动重登修复（冷却 5 分钟，失败 N 次移 repair_failed）
 *  - 主池可用数低于阈值 → 自动从备用池补号（有余额优先）
 * 单实例互斥；每轮结果与每账号动作写 monitor_logs，保留最近 100 轮。
 */

const PERMANENT_PATTERN = /account_deactivated|account_deleted|account_suspended|deactivated|permanently\s+deleted/i;
const LOG_ROUNDS_RETAINED = 100;

export function createMonitor({ db, crypto, client, getConfig, pools, engine, uploader, logger }) {
  const state = {
    running: false,
    timer: null,
    lastCheckAt: null,
    nextCheckAt: null,
    lastError: null,
    lastResult: null,
  };

  function monitorConfig() {
    return getConfig()?.monitor || {};
  }

  function startIfEnabled() {
    stop();
    const config = monitorConfig();
    if (!config.enabled) return;
    const intervalMs = Math.max(1, Number(config.interval_minutes) || 5) * 60_000;
    state.timer = setInterval(() => {
      runCheck({ source: 'timer' }).catch((error) => {
        state.lastError = sanitizeText(String(error.message || error)).slice(0, 400);
        logger.error({ err: error.message }, 'sub2api monitor check failed');
      });
    }, intervalMs);
    state.timer.unref?.();
    state.nextCheckAt = new Date(Date.now() + intervalMs).toISOString();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.nextCheckAt = null;
  }

  function view() {
    const config = monitorConfig();
    return {
      enabled: Boolean(config.enabled),
      running: state.running,
      interval_minutes: config.interval_minutes ?? 5,
      auto_repair: config.auto_repair !== false,
      max_repair_attempts: config.max_repair_attempts ?? 2,
      auto_replenish: Boolean(config.auto_replenish),
      reserve_threshold: config.reserve_threshold ?? 10,
      rate_limit_reset_threshold_hours: config.rate_limit_reset_threshold_hours ?? 12,
      last_check_at: state.lastCheckAt,
      next_check_at: state.nextCheckAt,
      last_error: state.lastError,
      last_result: state.lastResult,
    };
  }

  function startLog(source) {
    const info = db
      .prepare('INSERT INTO monitor_logs(source, started_at, status) VALUES (?, ?, ?)')
      .run(source, new Date().toISOString(), 'running');
    return Number(info.lastInsertRowid);
  }

  function finishLog(logId, status, result, error = null) {
    db.prepare('UPDATE monitor_logs SET finished_at=?, status=?, error=?, summary=? WHERE id=?').run(
      new Date().toISOString(),
      status,
      error ? sanitizeText(error).slice(0, 400) : null,
      JSON.stringify(result ?? {}),
      logId,
    );
    db.prepare(
      `DELETE FROM monitor_logs WHERE id NOT IN (SELECT id FROM monitor_logs ORDER BY id DESC LIMIT ${LOG_ROUNDS_RETAINED})`,
    ).run();
  }

  function writeLogItems(logId, items) {
    if (!items.length) return;
    const insert = db.prepare(
      'INSERT INTO monitor_log_items(log_id, email, remote_id, action, reason, detail) VALUES (?,?,?,?,?,?)',
    );
    const tx = db.transaction(() => {
      for (const item of items) {
        insert.run(
          logId,
          item.email ?? null,
          Number.isInteger(Number(item.remote_id)) ? Number(item.remote_id) : null,
          item.action,
          String(item.reason || '').slice(0, 100),
          String(item.detail || '').slice(0, 300),
        );
      }
    });
    tx();
  }

  /** 最近 N 轮巡检日志（含每账号明细）。 */
  function recentLogs(limit = 20) {
    const logs = db
      .prepare('SELECT * FROM monitor_logs ORDER BY id DESC LIMIT ?')
      .all(Math.min(100, Math.max(1, limit)));
    if (!logs.length) return [];
    const placeholders = logs.map(() => '?').join(',');
    const itemRows = db
      .prepare(`SELECT * FROM monitor_log_items WHERE log_id IN (${placeholders}) ORDER BY id ASC`)
      .all(...logs.map((row) => row.id));
    const itemsByLog = new Map();
    for (const row of itemRows) {
      if (!itemsByLog.has(row.log_id)) itemsByLog.set(row.log_id, []);
      itemsByLog.get(row.log_id).push({
        email: row.email,
        remote_id: row.remote_id,
        action: row.action,
        reason: row.reason,
        detail: row.detail,
      });
    }
    return logs.map((row) => ({
      id: row.id,
      source: row.source,
      started_at: row.started_at,
      finished_at: row.finished_at,
      status: row.status,
      error: row.error,
      summary: safeParseSummary(row.summary),
      items: itemsByLog.get(row.id) || [],
    }));
  }

  async function runCheck({ source = 'manual' } = {}) {
    if (state.running) return view();
    const config = getConfig();
    if (!config?.base_url || !config?.admin_key) {
      throw Object.assign(new Error('请先配置 sub2api'), { status: 422, code: 'SUB2API_NOT_CONFIGURED' });
    }
    state.running = true;
    const logId = startLog(source);
    const items = [];
    const result = { error_accounts: 0, rate_limited: 0, discarded: 0, repairing: 0, replenished: 0 };
    let accounts = null;
    try {
      const monitor = monitorConfig();
      const groupIds = Array.isArray(config.group_ids) ? config.group_ids : [];
      const bannedPatterns = (monitor.banned_patterns || []).filter(Boolean).map((p) => new RegExp(p, 'i'));
      const rateLimitPatterns = (monitor.rate_limit_patterns || []).filter(Boolean).map((p) => new RegExp(p, 'i'));
      const resetThresholdMs =
        Math.max(0, Number(monitor.rate_limit_reset_threshold_hours ?? 12)) * 3600_000;

      // 全量拉取一次：限流态不写 status=error，按 status 过滤会漏掉
      accounts = await client.listAllOpenAiAccounts();
      // 只监控本系统上传的 OAuth 授权号（free 号，oauth---邮箱 命名）：
      // type=oauth 过滤掉 API Key 号（plus/pro/team 等），本地邮箱匹配过滤掉非本系统上传的
      const localAccounts = db.prepare(`SELECT * FROM accounts WHERE pool IN ('main','reserve')`).all();
      const localByEmail = new Map(localAccounts.map((row) => [row.email.toLowerCase(), row]));
      const tracked = [];
      for (const remote of accounts) {
        if (String(remote.type || 'oauth') !== 'oauth') continue;
        if (!inMonitoredGroups(remote, groupIds)) continue;
        const email = client.accountEmail(remote);
        const local = email ? localByEmail.get(email.toLowerCase()) : null;
        if (local) tracked.push({ remote, local, email });
      }
      const errorMonitored = tracked.filter(({ remote }) => String(remote.status || '') === 'error');
      result.error_accounts = errorMonitored.length;

      for (const { remote, local, email } of tracked) {
        // OAuth 号限流态：重置时间距今超过阈值 → 废弃；短期限流 → 保留观察
        const rateLimit = client.accountRateLimit(remote);
        if (rateLimit.limited_now) {
          result.rate_limited += 1;
          const resetAt = rateLimit.rate_limit_reset_at;
          const resetMs = resetAt ? Date.parse(resetAt) - Date.now() : Number.NaN;
          const resetDesc = resetAt
            ? `${new Date(resetAt).toLocaleString('zh-CN', { hour12: false })}（约 ${formatDuration(resetMs)}）`
            : '未知时间';
          if (!Number.isFinite(resetMs) || resetMs > resetThresholdMs) {
            await discardLocal(local, 'rate_limited_429', `限流至 ${resetDesc}`, remote, monitor);
            result.discarded += 1;
            items.push({
              email,
              remote_id: remote?.id,
              action: 'discarded',
              reason: 'rate_limited_429',
              detail: `限流至 ${resetDesc}`,
            });
          } else {
            items.push({
              email,
              remote_id: remote?.id,
              action: 'rate_limited_waiting',
              reason: 'rate_limited_429',
              detail: `限流中，${resetDesc} 后恢复（低于废弃阈值，保留主池）`,
            });
          }
          continue;
        }

        if (String(remote.status || '') !== 'error') continue;
        const errorMessage = client.accountErrorMessage(remote) || 'unknown error';

        if (bannedPatterns.some((re) => re.test(errorMessage))) {
          await discardLocal(local, 'banned_401', errorMessage, remote, monitor);
          result.discarded += 1;
          items.push({ email, remote_id: remote?.id, action: 'discarded', reason: 'banned_401', detail: errorMessage });
          continue;
        }
        if (rateLimitPatterns.some((re) => re.test(errorMessage))) {
          await discardLocal(local, 'rate_limited_429', errorMessage, remote, monitor);
          result.discarded += 1;
          items.push({ email, remote_id: remote?.id, action: 'discarded', reason: 'rate_limited_429', detail: errorMessage });
          continue;
        }
        if (PERMANENT_PATTERN.test(errorMessage)) {
          db.prepare('UPDATE accounts SET auto_repair_blocked=1, updated_at=? WHERE id=?').run(
            new Date().toISOString(),
            local.id,
          );
          await discardLocal(local, 'banned_401', errorMessage, remote, monitor);
          result.discarded += 1;
          items.push({ email, remote_id: remote?.id, action: 'discarded', reason: 'banned_401', detail: errorMessage });
          continue;
        }

        // 临时错误 → 自动重登修复
        if (monitor.auto_repair !== false && tryAutoRepair(local, monitor)) {
          result.repairing += 1;
          items.push({ email, remote_id: remote?.id, action: 'repairing', reason: 'auto_repair', detail: errorMessage });
        } else {
          items.push({ email, remote_id: remote?.id, action: 'ignored', reason: 'temp_error', detail: errorMessage });
        }
      }

      // 自动补号
      if (monitor.auto_replenish) {
        result.replenished = await replenishIfNeeded(monitor, config, accounts);
      }

      state.lastCheckAt = new Date().toISOString();
      state.lastError = null;
      state.lastResult = result;
      finishLog(logId, 'done', result);
      writeLogItems(logId, items);
      logger.info({ source, ...result }, 'sub2api monitor check done');
    } catch (error) {
      finishLog(logId, 'failed', result, String(error.message || error));
      writeLogItems(logId, items);
      throw error;
    } finally {
      state.running = false;
    }
    return view();
  }

  async function discardLocal(local, reason, detail, remote, monitor) {
    try {
      pools.moveToDiscard(local.id, reason, detail);
    } catch (error) {
      logger.debug({ accountId: local.id }, `monitor discard skipped: ${error.message}`);
      return;
    }
    if (monitor.pause_on_discard !== false && Number.isInteger(Number(remote?.id))) {
      try {
        await client.setSchedulable(Number(remote.id), false);
      } catch (error) {
        logger.warn({ accountId: local.id, err: error.message }, 'pause remote on discard failed');
      }
    }
  }

  /** 自动修复资格：无活跃任务、未封禁、不在冷却期、修复失败次数未达上限。 */
  function tryAutoRepair(local, monitor) {
    if (local.auto_repair_blocked) return false;
    if (local.pool !== 'main') return false;
    const active = db
      .prepare(`SELECT id FROM jobs WHERE account_id=? AND status IN ('queued','running','awaiting_input')`)
      .get(local.id);
    if (active) return false;
    const maxAttempts = Number(monitor.max_repair_attempts) || 2;
    if ((local.repair_fail_count || 0) >= maxAttempts) {
      try {
        pools.moveToDiscard(local.id, 'repair_failed', `自动修复连续失败 ${local.repair_fail_count} 次`);
      } catch {}
      return false;
    }
    const cooldownMs = Math.max(0, Number(monitor.cooldown_minutes ?? 5)) * 60_000;
    if (local.last_auto_repair_at && Date.now() - Date.parse(local.last_auto_repair_at) < cooldownMs) {
      return false;
    }
    const tokens = local.tokens_enc ? crypto.tryDecryptJson(local.tokens_enc, 'accounts.tokens_enc') : null;
    if (!tokens?.refresh_token) return false;

    const now = new Date().toISOString();
    const cas = db
      .prepare(`UPDATE accounts SET status='authorizing', last_auto_repair_at=?, updated_at=? WHERE id=? AND pool='main' AND status IN ('active','needs_reauth')`)
      .run(now, now, local.id);
    if (cas.changes === 0) return false;
    engine.submitJob({ accountId: local.id, type: 'refresh', note: 'sub2api 自动修复' });
    pools.recordEvent(local.id, 'auto_repair_started', { source: 'monitor' });
    return true;
  }

  async function replenishIfNeeded(monitor, config, accounts = null) {
    const threshold = Number(monitor.reserve_threshold) || 10;
    const groupIds = Array.isArray(config.group_ids) ? config.group_ids : [];
    try {
      const allAccounts = accounts ?? (await client.listAllOpenAiAccounts());
      const monitoredAccounts = allAccounts.filter((account) => inMonitoredGroups(account, groupIds));
      const activeCount = monitoredAccounts.filter(
        (account) => String(account.status || 'active') === 'active' && String(account.name || '').startsWith('oauth---'),
      ).length;
      if (activeCount >= threshold) return 0;
      const gap = threshold - activeCount;
      // 从备用池挑号：有余额优先、未封禁、idle
      const candidates = db
        .prepare(
          `SELECT id FROM accounts WHERE pool='reserve' AND banned=0 AND status IN ('mail_pending','mail_failed','mail_ok')
           ORDER BY has_balance DESC, initial_balance DESC, imported_at ASC LIMIT ?`,
        )
        .all(Math.min(3, gap));
      if (!candidates.length) return 0;
      for (const candidate of candidates) {
        const now = new Date().toISOString();
        const tx = db.transaction(() => {
          const cas = db
            .prepare(`UPDATE accounts SET status='joining', updated_at=? WHERE id=? AND pool='reserve' AND status != 'joining'`)
            .run(now, candidate.id);
          if (cas.changes === 0) return;
          pools.recordEvent(candidate.id, 'join_started', { source: 'monitor_replenish' });
          engine.submitJob({ accountId: candidate.id, type: 'login', note: '自动补号' });
        });
        tx();
      }
      return candidates.length;
    } catch (error) {
      logger.warn({ err: error.message }, 'replenish check failed');
      return 0;
    }
  }

  function inMonitoredGroups(account, groupIds) {
    if (!groupIds.length) return true;
    const accountGroupIds = [
      ...(Array.isArray(account?.group_ids) ? account.group_ids : []),
      ...(Array.isArray(account?.account_groups) ? account.account_groups.map((item) => item?.group_id) : []),
    ].map(Number).filter(Number.isSafeInteger);
    return groupIds.some((id) => accountGroupIds.includes(Number(id)));
  }

  /** 修复成功回写远端（引擎 hooks 或 refresh 完成后调用）。 */
  async function pushRepairedCredentials(accountId) {
    const config = getConfig();
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    if (!row?.tokens_enc) return false;
    const tokens = crypto.tryDecryptJson(row.tokens_enc, 'accounts.tokens_enc');
    if (!tokens?.access_token) return false;
    let remoteId = row.sub2api_account_id;
    if (!Number.isInteger(remoteId)) {
      const accounts = await client.listAllOpenAiAccounts();
      const remote = accounts.find((acc) => client.accountEmail(acc) === row.email.toLowerCase());
      remoteId = remote ? Number(remote.id) : null;
    }
    if (!Number.isInteger(remoteId)) return false;
    const credentials = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: tokens.id_token,
      chatgpt_account_id: tokens.chatgpt_account_id,
      email: tokens.email,
    };
    await client.updateAccount(remoteId, { credentials });
    await client.clearError(remoteId);
    await client.setSchedulable(remoteId, true);
    db.prepare('UPDATE accounts SET repair_fail_count=0, updated_at=? WHERE id=?').run(
      new Date().toISOString(),
      accountId,
    );
    pools.recordEvent(accountId, 'sub2api_replaced', { source: 'auto_repair' });
    return true;
  }

  return { startIfEnabled, stop, view, runCheck, recentLogs, pushRepairedCredentials, state };
}

function safeParseSummary(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '未知';
  const hours = Math.floor(ms / 3600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
  if (hours >= 1) return `${hours} 小时 ${Math.floor((ms % 3600_000) / 60_000)} 分`;
  return `${Math.max(1, Math.floor(ms / 60_000))} 分钟`;
}
