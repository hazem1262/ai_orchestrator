import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDaemonClient, resolveDaemonConfig } from './daemon-client.ts';
import { createOrcMcpServer } from './server.ts';

const shellArg = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/** The commands that register orc-mcp with Claude Code and Codex. Printed only; never run here. */
export function installSnippet(entry: string): string {
  const arg = shellArg(entry);
  return [
    `claude mcp add --scope user orchestrator -- node ${arg}`,
    `codex mcp add orchestrator -- node ${arg}`,
  ].join('\n');
}

async function main(entry: string): Promise<void> {
  if (process.argv.includes('--print-install')) {
    process.stdout.write(`${installSnippet(entry)}\n`);
    return;
  }
  // stdout carries the MCP protocol only; everything else goes to stderr.
  const config = resolveDaemonConfig();
  const server = createOrcMcpServer(createDaemonClient(config), { webUrl: config.baseUrl });
  process.stderr.write(`orc-mcp talking to ${config.baseUrl}\n`);
  await server.connect(new StdioServerTransport());
}

const realpath = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const entry = fileURLToPath(import.meta.url);
const invoked = process.argv[1];

if (invoked && realpath(invoked) === realpath(entry)) {
  main(entry).catch((e: unknown) => {
    process.stderr.write(`orc-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
