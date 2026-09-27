import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DaemonClient } from './daemon-client.ts';
import { type OrcToolsOptions, registerOrcTools } from './tools.ts';

export function createOrcMcpServer(client: DaemonClient, opts: OrcToolsOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'orchestrator', version: '0.7.0' },
    {
      instructions:
        'Read-only view of the local AI-agent orchestrator: live sessions, the attention inbox, session search and work streams. resume_session can start a session in the orchestrator when launch=true.',
    },
  );
  registerOrcTools(server, client, opts);
  return server;
}
