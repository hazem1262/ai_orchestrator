import { timingSafeEqual } from 'node:crypto';

export function allowedHosts(port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (env.ORC_DEV === '1') hosts.push('127.0.0.1:5173', 'localhost:5173');
  return hosts;
}

export function allowedOrigins(port: number, env: NodeJS.ProcessEnv = process.env): string[] {
  return allowedHosts(port, env).map((h) => `http://${h}`);
}

export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isLoopback(addr: string | undefined): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
