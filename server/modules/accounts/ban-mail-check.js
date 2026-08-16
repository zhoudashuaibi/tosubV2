import {
  fetchReserveAccountMessages,
  isAccountBannedFromMessages,
} from '../../core/outlook-mail.mjs';

/**
 * 账号停用/封禁后的邮箱辅证检查（03 §9 辅佐比对）：
 * 登录 403 停用、监控 401 判封禁等场景落地后，再拉一次邮箱扫描封禁邮件。
 * 结果只写 account_events（ban_mail_check）并在命中时补 banned 标记，不改变已有池处置。
 */
export function createBanMailCheck({ db, getEndpoint, decryptCredentials, logger }) {
  function record(accountId, detail) {
    try {
      db.prepare('INSERT INTO account_events(account_id, type, detail, created_at) VALUES(?,?,?,?)').run(
        accountId,
        'ban_mail_check',
        JSON.stringify(detail),
        new Date().toISOString(),
      );
    } catch (error) {
      logger?.warn?.({ accountId, err: error.message }, 'ban mail check event write failed');
    }
  }

  async function check(accountId, { source = 'engine' } = {}) {
    let account;
    try {
      account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    } catch {}
    if (!account) return;
    const outlook = decryptCredentials(account)?.outlook;
    if (!outlook?.client_id || !outlook?.refresh_token) {
      record(accountId, { source, result: 'skipped', reason: '缺少 Outlook 取件凭据' });
      return;
    }
    try {
      const messages = await fetchReserveAccountMessages({
        endpoint: getEndpoint(),
        email: account.email,
        clientId: outlook.client_id,
        refreshToken: outlook.refresh_token,
        password: outlook.password || '',
      });
      const banInfo = isAccountBannedFromMessages(messages);
      if (banInfo.banned) {
        db.prepare('UPDATE accounts SET banned=1, banned_reason=?, updated_at=? WHERE id=?').run(
          banInfo.reason,
          new Date().toISOString(),
          accountId,
        );
        record(accountId, {
          source,
          result: 'confirmed',
          reason: banInfo.reason,
          messages_scanned: messages.length,
        });
      } else {
        record(accountId, { source, result: 'not_found', messages_scanned: messages.length });
      }
    } catch (error) {
      const message = String(error.message || error).slice(0, 300);
      record(accountId, { source, result: 'error', error: message });
      logger?.warn?.({ accountId, err: message }, 'ban mail check failed');
    }
  }

  return { check };
}
