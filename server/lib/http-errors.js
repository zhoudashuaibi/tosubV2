export class AppError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = status < 500;
    this.extra = extra;
  }
}

export const errors = {
  unauthorized: (message = '未登录或会话已过期') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = '操作不被允许', code = 'FORBIDDEN', extra = {}) => new AppError(403, code, message, extra),
  csrf: () => new AppError(403, 'CSRF_REJECTED', '请求缺少必要的 CSRF 校验头'),
  notFound: (message = '资源不存在') => new AppError(404, 'NOT_FOUND', message),
  validation: (message = '请求参数校验失败', details = {}) => new AppError(422, 'VALIDATION', message, { details }),
  conflict: (message, code = 'CONFLICT', extra = {}) => new AppError(409, code, message, extra),
  rateLimited: (retryAfterSeconds) =>
    new AppError(429, 'RATE_LIMITED', '尝试次数过多，已锁定', { retry_after_seconds: retryAfterSeconds }),
  upstream: (message, code = 'UPSTREAM_ERROR') => new AppError(502, code, message),
  sub2apiUnavailable: (message) => new AppError(502, 'SUB2API_UNAVAILABLE', message),
  accountState: (message) => new AppError(409, 'ACCOUNT_STATE_INVALID', message),
  jobNotCancelable: () => new AppError(409, 'JOB_NOT_CANCELABLE', '任务已结束，无法取消'),
  jobNotAwaitingInput: () => new AppError(409, 'JOB_NOT_AWAITING_INPUT', '任务当前不在等待输入状态'),
  poolTransferConflict: (message = '账号状态已变化，操作冲突') => new AppError(409, 'POOL_TRANSFER_CONFLICT', message),
};

export function registerErrorHandler(app) {
  app.setErrorHandler((error, request, reply) => {
    if (error?.validation) {
      const details = error.validation.map((item) => ({
        path: item.instancePath || item.params?.missingProperty || '',
        message: item.message || '',
      }));
      return reply.status(422).send({
        error: { code: 'VALIDATION', message: '请求参数校验失败', details },
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.status).send({
        error: { code: error.code, message: error.message, ...error.extra },
      });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({
      error: { code: 'INTERNAL', message: '服务器内部错误' },
    });
  });
}
