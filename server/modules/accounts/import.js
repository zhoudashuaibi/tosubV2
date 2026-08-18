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

/**
 * 2FA 取件码导入：两段格式解析（邮箱----2FA取件码）。
 * 返回逐行结果；ok 行带 { email, pickupCode }，供路由按邮箱关联到账号。
 */
const PICKUP_CODE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function parseTwofaLines(text) {
  const lines = String(text || '').split(/\r?\n/);
  const results = [];
  const seenInBatch = new Map(); // email -> line

  lines.forEach((rawLine, index) => {
    const lineNo = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    const parts = line.split('----');
    if (parts.length !== 2) {
      results.push({ line: lineNo, ok: false, reason: '格式错误，需要 2 段：邮箱----2FA取件码' });
      return;
    }
    const email = parts[0].trim().toLowerCase();
    const pickupCode = parts[1].trim();

    if (!EMAIL_PATTERN.test(email)) {
      results.push({ line: lineNo, ok: false, reason: '邮箱格式错误', raw: maskRaw(parts[0]) });
      return;
    }
    if (!PICKUP_CODE_PATTERN.test(pickupCode)) {
      results.push({ line: lineNo, ok: false, reason: '2FA 取件码应为 8-128 位字母数字', raw: maskRaw(parts[1]) });
      return;
    }
    if (seenInBatch.has(email)) {
      results.push({ line: lineNo, ok: false, duplicateInBatch: true, email, reason: '与第 ' + seenInBatch.get(email) + ' 行重复' });
      return;
    }
    seenInBatch.set(email, lineNo);
    results.push({ line: lineNo, ok: true, email, pickupCode });
  });

  return results;
}

export function credentialsForImport(entry) {
  const credentials = {
    outlook: {
      password: entry.password,
      client_id: entry.clientId,
      refresh_token: entry.refreshToken,
    },
  };
  if (entry.pickupCode) credentials.totp_pickup_code = entry.pickupCode;
  if (entry.chatgptPassword) credentials.password = entry.chatgptPassword;
  return credentials;
}

/**
 * ChatGPT 会话导出文件解析：密码在 meta.label 的第 3 段（label 形如 "email----xxxx----密码"）。
 * 只有邮箱或不足 3 段的条目视为无密码账号，跳过；也兼容直接粘贴 label 行。
 * 返回 { ok, passwords: Map<email, password>, error }。
 */
export function parsePasswordFileText(text) {
  const raw = String(text || '').trim();
  const passwords = new Map();
  if (!raw) return { ok: true, passwords, error: null };

  const addLabel = (label) => {
    const parts = String(label || '').split('----').map((p) => p.trim());
    if (parts.length < 3) return;
    const email = parts[0].toLowerCase();
    const password = parts[2];
    if (!EMAIL_PATTERN.test(email) || !password) return;
    if (!passwords.has(email)) passwords.set(email, password);
  };

  if (raw.startsWith('[') || raw.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, passwords, error: '密码文件不是合法的 JSON' };
    }
    for (const item of Array.isArray(data) ? data : [data]) addLabel(item?.meta?.label);
    return { ok: true, passwords, error: null };
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    addLabel(trimmed);
  }
  return { ok: true, passwords, error: null };
}

export function proxyUrlHash(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex');
}
