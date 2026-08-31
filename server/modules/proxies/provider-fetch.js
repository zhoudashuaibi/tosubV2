import { parseReplaceLines } from '../sub2api/proxy-replace.js';

/**
 * 动态住宅 IP 服务商提取接口（1024proxy 风格 getIpInfo）：
 * 用户粘贴完整模板链接（含 key/country/type/format 等），提取时只动态覆盖 num（提取数量）。
 * ips 白名单参数不传时服务商会自动把发起请求的本机（服务器）出口 IP 加白，无需干预。
 */

/** 覆盖模板链接的 num 参数；模板非法或非 http(s) 抛错。 */
export function buildExtractUrl(template, num) {
  let url;
  try {
    url = new URL(String(template || '').trim());
  } catch {
    throw new Error('API 提取链接格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('API 提取链接必须使用 HTTP 或 HTTPS');
  }
  url.searchParams.set('num', String(Math.max(1, Math.floor(num))));
  return url.href;
}

/** JSON 响应里的代理数组：元素可为字符串行或 {host/ip, port, username/user, password/pass} 对象。 */
function linesFromJson(payload) {
  const list = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray(payload.data)
      ? payload.data
      : payload && typeof payload === 'object' && Array.isArray(payload.list)
        ? payload.list
        : null;
  if (!list) return null;
  return list.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') {
      const host = item.host ?? item.ip ?? item.ip_address;
      const username = item.username ?? item.user;
      const password = item.password ?? item.pass;
      if (!host || !item.port) return '';
      return username ? `${host}:${item.port}:${username}:${password ?? ''}` : `${host}:${item.port}`;
    }
    return '';
  });
}

/**
 * 调用服务商提取接口，返回 { items, invalid_lines }（items 为 host/port/username/password 条目，
 * 与一键更换粘贴文本同构）。文本按行解析（type=1/2/3 格式均被 parseReplaceLines 覆盖）；
 * 一条都解析不出时抛错并附响应片段（暴露"余额不足"类文本错误）。
 */
export async function fetchNewProxies(template, num, { timeoutMs = 20_000 } = {}) {
  const url = buildExtractUrl(template, num);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json, text/plain, */*' },
  });
  if (!response.ok) {
    throw new Error(`API 提取接口返回 HTTP ${response.status}`);
  }
  const text = (await response.text()).trim();
  if (!text) throw new Error('API 提取接口返回空响应');

  let lines = null;
  try {
    lines = linesFromJson(JSON.parse(text));
  } catch {
    lines = null; // 纯文本响应
  }
  if (lines === null) lines = text.split(/\r?\n/);

  const { items, invalid_lines: invalidLines } = parseReplaceLines(lines.filter(Boolean).join('\n'));
  if (items.length === 0) {
    throw new Error(`API 提取响应中没有可用代理：${text.slice(0, 200)}`);
  }
  return { items, invalid_lines: invalidLines };
}
