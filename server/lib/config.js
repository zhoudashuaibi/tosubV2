import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(__dirname, '..');
export const VERSION = '2.0.0';

function resolveDataDir(raw) {
  const value = String(raw || '').trim();
  if (!value) return path.join(SERVER_ROOT, '..', 'data');
  return path.resolve(value);
}

export function loadConfig(env = process.env) {
  const dataDir = resolveDataDir(env.TOSUB2_DATA_DIR);
  const inContainer = Boolean(env.TOSUB2_IN_CONTAINER);
  return {
    version: VERSION,
    host: env.TOSUB2_HOST || (inContainer ? '0.0.0.0' : '127.0.0.1'),
    port: Number.parseInt(env.TOSUB2_PORT || '1999', 10) || 1999,
    dataDir,
    dbPath: path.join(dataDir, 'tosub2.db'),
    secretKeyEnv: String(env.TOSUB2_SECRET_KEY || '').trim(),
    consolePasswordSeed: String(env.TOSUB2_CONSOLE_PASSWORD || ''),
    forceSecureCookie: env.TOSUB2_FORCE_SECURE_COOKIE === '1',
    logLevel: env.TOSUB2_LOG_LEVEL || (env.NODE_ENV === 'test' ? 'silent' : 'info'),
    webDist: String(env.TOSUB2_WEB_DIST || '').trim() || path.join(SERVER_ROOT, 'web-dist'),
    serverRoot: SERVER_ROOT,
    coreDir: path.join(SERVER_ROOT, 'core'),
    logsDir: path.join(dataDir, 'logs'),
    checkpointsDir: path.join(dataDir, 'checkpoints'),
    resultsDir: path.join(dataDir, 'results'),
    sessionTtlDays: 30,
    loginMaxFails: 5,
    loginLockMinutes: 15,
  };
}
