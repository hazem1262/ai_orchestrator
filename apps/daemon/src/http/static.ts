import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { OrcApp } from './types.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export function registerStatic(app: OrcApp, root: string): void {
  const base = resolve(root);
  app.get('*', async (c) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      urlPath = '/';
    }
    const candidate = resolve(base, `.${urlPath}`);
    const inside = candidate.startsWith(`${base}${sep}`);
    const file = inside && (await isFile(candidate)) ? candidate : join(base, 'index.html');
    if (!(await isFile(file))) return c.text('web app not built: run `pnpm --filter @orc/web build`', 404);
    const body = await readFile(file);
    const isIndex = file === join(base, 'index.html');
    return c.body(body, 200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': isIndex ? 'no-store' : 'public, max-age=31536000, immutable',
    });
  });
}
