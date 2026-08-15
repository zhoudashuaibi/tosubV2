import fs from 'node:fs';
import path from 'node:path';
import { fastifyStatic } from '@fastify/static';

export function createStaticModule({ config, logger }) {
  return async function staticModule(app) {
    const distDir = config.webDist;
    if (!fs.existsSync(distDir)) {
      logger.warn(`前端构建产物不存在：${distDir}（开发模式请使用 vite dev server）`);
      app.setNotFoundHandler(async (_request, reply) => {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '资源不存在' } });
      });
      return;
    }
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      index: 'index.html',
    });
    // SPA fallback：非 /api 路径全部回 index.html
    app.setNotFoundHandler(async (request, reply) => {
      if (request.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '接口不存在' } });
      }
      return reply.sendFile('index.html', path.resolve(distDir));
    });
  };
}
