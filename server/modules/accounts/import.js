import crypto from 'node:crypto';

/**
 * 备用号池导入：四段格式解析（邮箱----密码----clientId----refreshToken）+ 校验。
 * 与 v1 parseOutlookEntries 语义一致，但逐行返回结果（不因单行失败中断）。
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseImportLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const results = [];
  const seenInBatch = new Map(); // email -> line

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    const parts = line.split('----');
    if (parts.length < 4) {
      results.push({ line: lineNo, ok: false, reason: '格式错误，需要 4 段：邮箱----密码----clientId----refreshToken' });
      return;
    }
    const email = parts[0].trim().toLowerCase();
    const password = parts[1].trim();
    const clientId = parts[2].trim();
    const refreshToken = parts.slice(3).join('----').trim();

    if (!EMAIL_PATTERN.test(email)) {
      results.push({ line: lineNo, ok: false, reason: '邮箱格式错误', raw: maskRaw(parts[0]) });
      return;
    }
    if (!password) {
      results.push({ line: lineNo, ok: false, reason: '邮箱密码不能为空' });
      return;
    }
    if (!UUID_PATTERN.test(clientId)) {
      results.push({ line: lineNo, ok: false, reason: 'clientId 不是 UUID', raw: maskRaw(parts[2]) });
      return;
    }
    if (refreshToken.length < 100) {
      results.push({ line: lineNo, ok: false, reason: 'refresh_token 长度不足', raw: maskRaw(parts[3]) });
      return;
    }
    if (seenInBatch.has(email)) {
      results.push({ line: lineNo, ok: false, duplicateInBatch: true, email, reason: '与第 ' + seenInBatch.get(email) + ' 行重复' });
      return;
    }
    seenInBatch.set(email, lineNo);
    results.push({ line: lineNo, ok: true, email, password, clientId, refreshToken });
  });

  return results;
}

function maskRaw(value) {
  const text = String(value || '');
  return text.length > 12 ? `${text.slice(0, 6)}...` : '***';
}

export function credentialsForImport(entry) {
  return {
    outlook: {
      password: entry.password,
      client_id: entry.clientId,
      refresh_token: entry.refreshToken,
    },
  };
}

export function proxyUrlHash(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}
