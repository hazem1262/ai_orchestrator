import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { OrcConfig } from '@orc/api-contract';
import { z } from 'zod';

export interface OrcPaths {
  orcHome: string;
  claudeHome: string;
  codexHome: string;
  dbFile: string;
  tokenFile: string;
  archiveDir: string;
  logFile: string;
  userHome: string;
}

function expand(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): OrcPaths {
  const orcHome = expand(env.ORC_HOME ?? join(homedir(), '.orchestrator'));
  return {
    orcHome,
    claudeHome: expand(env.CLAUDE_HOME ?? join(homedir(), '.claude')),
    codexHome: expand(env.CODEX_HOME ?? join(homedir(), '.codex')),
    dbFile: join(orcHome, 'index.db'),
    tokenFile: join(orcHome, 'token'),
    archiveDir: join(orcHome, 'archive'),
    logFile: join(orcHome, 'logs', 'daemon.log'),
    userHome: expand(env.ORC_USER_HOME ?? homedir()),
  };
}

function writePrivate(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const configFile = (paths: OrcPaths) => join(paths.orcHome, 'config.json');

/**
 * Formats a zod issue path/message combo into something a human hand-editing
 * config.json can act on, instead of surfacing a raw ZodError stack.
 */
function describeConfigError(file: string, err: unknown): Error {
  if (err instanceof z.ZodError) {
    const details = err.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `  - ${path}: ${issue.message}`;
      })
      .join('\n');
    return new Error(`Invalid orchestrator config at ${file}:\n${details}`);
  }
  if (err instanceof SyntaxError) {
    return new Error(`Invalid orchestrator config at ${file}: not valid JSON (${err.message})`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function loadConfig(paths: OrcPaths): OrcConfig {
  const file = configFile(paths);
  if (!existsSync(file)) {
    const cfg = OrcConfig.parse({});
    saveConfig(paths, cfg);
    return cfg;
  }
  try {
    return OrcConfig.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    throw describeConfigError(file, err);
  }
}

export function saveConfig(paths: OrcPaths, cfg: OrcConfig): void {
  writePrivate(configFile(paths), `${JSON.stringify(OrcConfig.parse(cfg), null, 2)}\n`);
}

export function ensureToken(paths: OrcPaths): string {
  if (existsSync(paths.tokenFile)) {
    chmodSync(paths.tokenFile, 0o600);
    return readFileSync(paths.tokenFile, 'utf8').trim();
  }
  const token = randomBytes(32).toString('hex');
  writePrivate(paths.tokenFile, token);
  return token;
}
