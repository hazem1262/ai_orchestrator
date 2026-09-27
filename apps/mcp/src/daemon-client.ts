import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export class DaemonError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DaemonError';
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_PORT = 4317;

/** The daemon's own `config.json` port, so orc-mcp follows a non-default port without extra setup. */
function configPort(orcHome: string): number | null {
  try {
    const cfg = JSON.parse(readFileSync(join(orcHome, 'config.json'), 'utf8')) as { port?: unknown };
    return typeof cfg.port === 'number' && Number.isInteger(cfg.port) ? cfg.port : null;
  } catch {
    return null;
  }
}

/**
 * Order matches the daemon: `ORC_URL`, then `ORC_PORT`, then `$ORC_HOME/config.json`, then 4317.
 * The token is `ORC_TOKEN` or `$ORC_HOME/token` (written by the daemon's `ensureToken`). Read-only.
 */
export function resolveDaemonConfig(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: string;
  token: string;
} {
  const orcHome = env.ORC_HOME ?? join(homedir(), '.orchestrator');
  let token = env.ORC_TOKEN;
  if (!token) {
    const tokenFile = join(orcHome, 'token');
    try {
      token = readFileSync(tokenFile, 'utf8').trim();
    } catch (e) {
      throw new Error(
        `orc-mcp cannot read the orchestrator token at ${tokenFile} (start the daemon once, or set ORC_TOKEN): ${(e as Error).message}`,
      );
    }
  }
  const port = env.ORC_PORT ?? String(configPort(orcHome) ?? DEFAULT_PORT);
  const baseUrl = (env.ORC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  return { baseUrl, token };
}

export function createDaemonClient(o: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}): DaemonClient {
  const doFetch = o.fetch ?? fetch;

  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${o.baseUrl}${path}`, {
        method,
        headers: { 'x-orc-token': o.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new DaemonError(
        0,
        'daemon_unreachable',
        `cannot reach the orchestrator daemon at ${o.baseUrl}: ${(e as Error).message}`,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      throw new DaemonError(res.status, err?.code ?? 'http_error', err?.message ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  return {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body),
  };
}
