import fs from 'node:fs';
import path from 'node:path';
import { fetchOutlookOtpCandidates } from '../../core/outlook-mail.mjs';
import { fetchMailboxOtpCandidates } from '../../core/mail-otp.mjs';
import { createSmsProvider } from '../../core/sms-providers.mjs';
import { generateTotp } from '../../lib/totp.js';

/**
 * input_required 自动作答（03 §8.4）。
 * 每个运行中任务维护一个 AutoInputSession：
 *  - email_otp：Outlook 轮询（2.5s/10min，基准去重）→ 泛化收码 API
 *  - password / mfa_otp / totp_setup_otp：凭据直答
 *  - phone / phone_otp：接码平台取号收码
 * 自动源不可用或失败 → 返回 { wait: true }，引擎置 awaiting_input 等人工。
 */

const OTP_POLL_INTERVAL_MS = 2500;
const OTP_POLL_MAX_MS = 10 * 60 * 1000;

export function createAutoInput({ config, logger }) {
  const sessions = new Map(); // jobId -> session state

  function reset(jobId) {
    sessions.delete(jobId);
  }

  /**
   * 尝试自动作答。返回：
   *  { submit: {action:'input', value} }  自动作答成功，立即写子进程 stdin
   *  { wait: true }                       无自动源，等待人工
   *  { defer: ms }                        轮询中，稍后重试
   */
  async function attempt(job, account, promptEvent, { stageStartedAt } = {}) {
    const kind = promptEvent.kind;
    const credentials = account?.credentials || {};
    const session = ensureSession(job.id, kind);

    if (kind === 'password') {
      if (credentials.password) return { submit: { action: 'input', value: credentials.password } };
      return { wait: true };
    }

    if (kind === 'mfa_otp' || kind === 'totp_setup_otp') {
      if (credentials.totp_secret) {
        try {
          // 含失败重试一次的时钟偏移容错：先当前窗口，被拒后引擎重触发时换下一候选
          const candidates = [0, -30_000, 30_000];
          const offset = candidates[session.totpTryIndex % candidates.length];
          session.totpTryIndex = (session.totpTryIndex || 0) + 1;
          return { submit: { action: 'input', value: generateTotp(credentials.totp_secret, Date.now() + offset) } };
        } catch (error) {
          logger?.warn?.({ jobId: job.id, err: error.message }, 'TOTP 生成失败');
          return { wait: true };
        }
      }
      return { wait: true };
    }

    if (kind === 'email_otp') {
      return pollEmailOtp(job, account, session, stageStartedAt);
    }

    if (kind === 'phone') {
      return handlePhone(job, account, session);
    }

    if (kind === 'phone_otp') {
      return handlePhoneOtp(job, account, session);
    }

    return { wait: true };
  }

  async function pollEmailOtp(job, account, session, stageStartedAt) {
    const credentials = account?.credentials || {};
    const startedAt = stageStartedAt || session.firstAskedAt || Date.now();
    if (Date.now() - startedAt > OTP_POLL_MAX_MS) return { wait: true };

    const poll = async () => {
      // 基准：页面加载前 60s 内的邮件都算「可能的新码」，用 seen 集合去重旧码
      const baselineTime = startedAt - 60_000;
      let candidates = [];
      if (credentials.outlook?.refresh_token) {
        candidates = await fetchOutlookOtpCandidates({
          endpoint: getOutlookEndpoint(),
          email: account.email,
          clientId: credentials.outlook.client_id,
          refreshToken: credentials.outlook.refresh_token,
          password: credentials.outlook.password || '',
        }, { baselineTime });
      } else if (credentials.mail_api_url) {
        const raw = await fetchMailboxOtpCandidates(credentials.mail_api_url);
        candidates = (raw || [])
          .filter((item) => !item.receivedAt || item.receivedAt >= baselineTime)
          .map((item) => ({ ...item, key: item.key || item.code }));
      } else {
        return null; // 无自动源
      }
      return candidates;
    };

    try {
      const candidates = await poll();
      if (candidates === null) return { wait: true };
      const fresh = candidates.filter((item) => !session.seenKeys.has(item.key));
      for (const item of candidates) session.seenKeys.add(item.key);
      if (fresh.length) {
        fresh.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.receivedAt || 0) - (a.receivedAt || 0));
        return { submit: { action: 'input', value: fresh[0].code } };
      }
      return { defer: OTP_POLL_INTERVAL_MS };
    } catch (error) {
      session.pollErrors = (session.pollErrors || 0) + 1;
      logger?.warn?.({ jobId: job.id, err: String(error.message || error).slice(0, 160) }, 'email OTP 轮询失败');
      if (session.pollErrors >= 3) return { wait: true };
      return { defer: OTP_POLL_INTERVAL_MS * 2 };
    }
  }

  async function handlePhone(job, account, session) {
    const provider = getSmsProvider();
    if (!provider) return { wait: true };
    try {
      const { requestId, number } = await provider.getNumber();
      if (!number) return { wait: true };
      session.smsRequestId = requestId;
      session.smsPhone = number;
      session.smsAcquiredAt = Date.now();
      return { submit: { action: 'input', value: number } };
    } catch (error) {
      logger?.warn?.({ jobId: job.id, err: String(error.message || error).slice(0, 160) }, '接码平台取号失败');
      return { wait: true };
    }
  }

  async function handlePhoneOtp(job, account, session) {
    const provider = getSmsProvider();
    if (!provider || !session.smsRequestId) return { wait: true };
    if (Date.now() - (session.smsAcquiredAt || 0) > OTP_POLL_MAX_MS) {
      try {
        provider.release?.(session.smsRequestId);
      } catch {}
      return { wait: true };
    }
    try {
      const result = await provider.getSms(session.smsRequestId);
      if (result?.status === 'received' && result.code) {
        try {
          provider.complete?.(session.smsRequestId);
        } catch {}
        return { submit: { action: 'input', value: String(result.code) } };
      }
      return { defer: 5000 };
    } catch (error) {
      session.smsErrors = (session.smsErrors || 0) + 1;
      logger?.warn?.({ jobId: job.id, err: String(error.message || error).slice(0, 160) }, '接码平台收码失败');
      if (session.smsErrors >= 3) return { wait: true };
      return { defer: 8000 };
    }
  }

  function getSmsProviderState() {
    return smsProviderState;
  }

  let smsProviderState = { cached: null, source: null };

  function getSmsProvider() {
    if (smsProviderState.cached) return smsProviderState.cached;
    const settings = config.settingsGet?.('sms.providers') || {};
    const id = String(settings.active || '').trim();
    if (!id) return null;
    const providerConfig = settings[id];
    if (!providerConfig) return null;
    try {
      const provider = createSmsProvider(id, providerConfig);
      smsProviderState.cached = provider;
      return provider;
    } catch {
      return null;
    }
  }

  function invalidateSmsProvider() {
    smsProviderState.cached = null;
  }

  function ensureSession(jobId, kind) {
    let session = sessions.get(jobId);
    if (!session) {
      session = { jobId, kind, seenKeys: new Set(), firstAskedAt: Date.now(), totpTryIndex: 0 };
      sessions.set(jobId, session);
    }
    return session;
  }

  function getOutlookEndpoint() {
    const settings = config.settingsGet?.('outlook.fetch') || {};
    return settings.endpoint || 'https://8t92.cc/api/fetch-mails';
  }

  return { attempt, reset, invalidateSmsProvider, getSmsProviderState };
}

/** 读取 refresh/login 产物 JSON（sub2api 导出文件）。 */
export function readSub2apiExport(dataDir, relativePath) {
  const resolved = path.resolve(dataDir, relativePath);
  if (!resolved.startsWith(path.resolve(dataDir))) throw new Error('产物路径越界');
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}
