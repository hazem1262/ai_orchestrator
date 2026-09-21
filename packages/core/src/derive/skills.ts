/** Claude Code built-in commands that are UI actions, not skills. */
const BUILTIN_COMMANDS = new Set([
  'add-dir',
  'agents',
  'bug',
  'clear',
  'compact',
  'config',
  'context',
  'cost',
  'doctor',
  'effort',
  'exit',
  'fast',
  'help',
  'hooks',
  'ide',
  'login',
  'logout',
  'mcp',
  'memory',
  'model',
  'permissions',
  'resume',
  'rewind',
  'status',
  'statusline',
  'terminal-setup',
  'theme',
  'usage',
  'vim',
]);

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

export function slashCommand(prompt: string): string | null {
  const m = /^\/([A-Za-z][\w:.-]*)(?=\s|$)/.exec(prompt.trimStart());
  const name = m?.[1];
  if (!name) return null;
  const lower = name.toLowerCase();
  return BUILTIN_COMMANDS.has(lower) ? null : lower;
}

export function mcpServerOf(tool: string): string | null {
  return MCP_NAME.exec(tool)?.[1] ?? null;
}

export function mcpToolLabel(tool: string): string {
  const m = MCP_NAME.exec(tool);
  if (!m) return tool;
  const server = (m[1] ?? '').replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '');
  return `${server} ${m[2] ?? ''}`.trim();
}
