import type { AgncEvent, AgncMessage, AgncSession } from '@orc/api-contract';

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

const firstString = (o: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const k of keys) {
    const v = str(o[k]);
    if (v !== null) return v;
  }
  return null;
};

/** MCP tool results carry either structuredContent or a JSON string in a text block. */
export function toolPayload(result: unknown): unknown {
  if (!isObj(result)) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find((c) => isObj(c) && c.type === 'text');
  const text = isObj(textBlock) ? str(textBlock.text) : null;
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function pickArray(value: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObj(value)) return [];
  for (const k of keys) {
    const v = value[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

export function normalizeSession(raw: unknown): AgncSession | null {
  if (!isObj(raw)) return null;
  const id = firstString(raw, ['id', 'sessionId', 'session_id']);
  if (!id) return null;
  const repo = isObj(raw.repository) ? raw.repository : isObj(raw.repo) ? raw.repo : {};
  return {
    id,
    title: firstString(raw, ['title', 'name', 'summary']),
    status: firstString(raw, ['status', 'state', 'phase']) ?? 'unknown',
    repoOwner:
      firstString(raw, ['repoOwner', 'repo_owner', 'owner']) ?? firstString(repo, ['owner', 'login']),
    repoName: firstString(raw, ['repoName', 'repo_name', 'repo']) ?? firstString(repo, ['name']),
    branch: firstString(raw, ['branch', 'headBranch', 'head_branch', 'baseBranch', 'base_branch']),
    prUrl: firstString(raw, ['prUrl', 'pr_url', 'pullRequestUrl', 'pull_request_url']),
    url: firstString(raw, ['url', 'webUrl', 'web_url', 'htmlUrl']),
    createdAt: firstString(raw, ['createdAt', 'created_at']),
    updatedAt: firstString(raw, ['updatedAt', 'updated_at']),
  };
}

export function normalizeMessage(raw: unknown): AgncMessage | null {
  if (!isObj(raw)) return null;
  const id = firstString(raw, ['id', 'messageId', 'message_id']);
  if (!id) return null;
  const content = raw.content;
  const text =
    firstString(raw, ['text', 'content', 'body']) ??
    (Array.isArray(content)
      ? content
          .map((c) => (isObj(c) ? (str(c.text) ?? '') : ''))
          .filter(Boolean)
          .join('\n')
      : '');
  return {
    id,
    role: firstString(raw, ['role', 'author', 'sender']) ?? 'assistant',
    status: firstString(raw, ['status', 'state']),
    text,
    createdAt: firstString(raw, ['createdAt', 'created_at']),
  };
}

export function normalizeEvent(raw: unknown): AgncEvent | null {
  if (!isObj(raw)) return null;
  const id = firstString(raw, ['id', 'eventId', 'event_id']);
  if (!id) return null;
  return {
    id,
    type: firstString(raw, ['type', 'kind', 'name']) ?? 'event',
    messageId: firstString(raw, ['messageId', 'message_id']),
    text: firstString(raw, ['text', 'detail', 'message', 'summary']),
    createdAt: firstString(raw, ['createdAt', 'created_at', 'ts']),
  };
}
