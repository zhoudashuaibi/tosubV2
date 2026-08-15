export class ApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const BASE = '/api/v1';

interface RequestOptions {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

export async function api<T>(path: string, init?: RequestOptions): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? (init?.json !== undefined ? 'POST' : 'GET'),
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(init?.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    body: init?.json !== undefined ? JSON.stringify(init.json) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.dispatchEvent(new CustomEvent('tosub2:unauthorized'));
    throw new ApiError('UNAUTHORIZED', '登录已过期');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(
      (body as { error?: { code?: string } })?.error?.code ?? 'UNKNOWN',
      (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** 文件下载（导出/产物下载，GET 带 Cookie） */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new ApiError('DOWNLOAD_FAILED', '下载失败');
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') || '';
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const name = match?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export const ERROR_LABELS: Record<string, string> = {
  UNAUTHORIZED: '登录已过期',
  RATE_LIMITED: '操作过于频繁',
  SUB2API_UNAVAILABLE: 'sub2api 连接失败',
  SUB2API_NOT_CONFIGURED: '请先配置 sub2api',
  CSRF_REJECTED: '请求校验失败，请刷新页面重试',
  VALIDATION: '请求参数不合法',
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return ERROR_LABELS[error.code] ?? error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
