import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAccountBannedFromMessages, extractBalanceFromMessages } from '../core/outlook-mail.mjs';
import { createBanMailCheck } from '../modules/accounts/ban-mail-check.js';

function message(subject, body, receivedDateTime = '2026-08-15T10:00:00Z') {
  return { subject, bodyPreview: '', body: { content: body }, receivedDateTime };
}

test('封禁邮件判定：英文关键字', () => {
  assert.equal(
    isAccountBannedFromMessages([message('Your account', 'Your account has been deactivated.')]).banned,
    true,
  );
  assert.equal(
    isAccountBannedFromMessages([message('Notice', 'account_deactivated by provider')]).banned,
    true,
  );
});

test('封禁邮件判定：中文关键字（账户已被停用等）', () => {
  assert.equal(
    isAccountBannedFromMessages([message('您的账户', '您的账户已被停用。如果您认为这是误判，请联系我们。')]).banned,
    true,
  );
  assert.equal(
    isAccountBannedFromMessages([message('通知', '经审查，帐号已被停用，立即生效。')]).banned,
    true,
  );
  assert.equal(
    isAccountBannedFromMessages([message('通知', '您的账号已被封禁。')]).banned,
    true,
  );
});

test('封禁邮件判定：正常邮件不误判', () => {
  assert.equal(
    isAccountBannedFromMessages([message('Your ChatGPT code', 'Your code is 123456')]).banned,
    false,
  );
  assert.equal(isAccountBannedFromMessages([]).banned, false);
});

test('余额邮件解析保持不变', () => {
  const result = extractBalanceFromMessages([message('Credits', "We've added 100 credits to your account")]);
  assert.equal(result.hasBalance, true);
  assert.equal(result.balance, 4);
});

function mockDb(row) {
  const events = [];
  const updates = [];
  const db = {
    prepare(sql) {
      return {
        get: () => row,
        run: (...args) => {
          if (sql.startsWith('INSERT INTO account_events')) events.push(JSON.parse(args[2]));
          if (sql.startsWith('UPDATE accounts SET banned')) updates.push(args);
        },
      };
    },
    _events: events,
    _updates: updates,
  };
  return db;
}

async function withFetchMock(payload, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('ban-mail-check：命中封禁邮件 → banned 标记 + confirmed 事件', async () => {
  const db = mockDb({ id: 1, email: 'a@b.com', credentials_enc: 'enc' });
  const banCheck = createBanMailCheck({
    db,
    getEndpoint: () => 'https://example.test/api/fetch-mails',
    decryptCredentials: () => ({ outlook: { client_id: 'x', refresh_token: 'y' } }),
    logger: null,
  });
  await withFetchMock(
    {
      results: [
        { ok: true, email: 'a@b.com', messages: [message('您的账户', '您的账户已被停用。')] },
      ],
    },
    () => banCheck.check(1, { source: 'test' }),
  );
  assert.equal(db._events.length, 1);
  assert.equal(db._events[0].result, 'confirmed');
  assert.equal(db._updates.length, 1);
});

test('ban-mail-check：无封禁邮件 → not_found 事件，不改 banned', async () => {
  const db = mockDb({ id: 2, email: 'c@d.com', credentials_enc: 'enc' });
  const banCheck = createBanMailCheck({
    db,
    getEndpoint: () => 'https://example.test/api/fetch-mails',
    decryptCredentials: () => ({ outlook: { client_id: 'x', refresh_token: 'y' } }),
    logger: null,
  });
  await withFetchMock(
    { results: [{ ok: true, email: 'c@d.com', messages: [message('Your code', 'code 123456')] }] },
    () => banCheck.check(2, { source: 'test' }),
  );
  assert.equal(db._events.length, 1);
  assert.equal(db._events[0].result, 'not_found');
  assert.equal(db._updates.length, 0);
});

test('ban-mail-check：缺少 Outlook 凭据 → skipped 事件', async () => {
  const db = mockDb({ id: 3, email: 'e@f.com', credentials_enc: 'enc' });
  const banCheck = createBanMailCheck({
    db,
    getEndpoint: () => 'https://example.test/api/fetch-mails',
    decryptCredentials: () => ({}),
    logger: null,
  });
  await banCheck.check(3, { source: 'test' });
  assert.equal(db._events.length, 1);
  assert.equal(db._events[0].result, 'skipped');
});
