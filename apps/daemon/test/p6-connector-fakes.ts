import type { LinearIssue } from '@orc/api-contract';
import type { LinearApi } from '../src/connectors/linear/api.ts';
import type { SlackApi, SlackMessage } from '../src/connectors/slack/api.ts';
import { compareSlackTs } from '../src/connectors/slack/text.ts';
import type { Phase6Options } from '../src/phase6.ts';
import { createMemorySecretStore } from '../src/services/secrets/secret-store.ts';

export function linearIssue(identifier: string, o: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: `id-${identifier}`,
    identifier,
    title: `Title of ${identifier}`,
    state: 'In Progress',
    assignee: 'Test User',
    url: `https://linear.app/example/issue/${identifier}`,
    labels: [],
    ...o,
  };
}

const authError = () =>
  Object.assign(new Error('Authentication required, not authenticated'), { type: 'AuthenticationError' });

export function fakeLinearApi() {
  const control = { failAuth: false };
  const comments: Array<{ issueId: string; body: string }> = [];
  const created: Array<{ teamId: string; title: string; description: string; assigneeId?: string }> = [];
  const issues = new Map<string, LinearIssue>([['SAF-1787', linearIssue('SAF-1787')]]);
  const assigned: LinearIssue[] = [];
  const issueCalls: string[] = [];
  const api: LinearApi = {
    viewer: async () => {
      if (control.failAuth) throw authError();
      return { id: 'user-1', name: 'Test User', email: 'me@example.com' };
    },
    issue: async (identifier) => {
      if (control.failAuth) throw authError();
      issueCalls.push(identifier);
      return issues.get(identifier) ?? null;
    },
    createComment: async (issueId, body) => {
      comments.push({ issueId, body });
    },
    teamIdByKey: async (key) => (key === 'SAF' ? 'team-saf' : null),
    createIssue: async (input) => {
      created.push(input);
      const issue = linearIssue(`SAF-${2000 + created.length}`, {
        title: input.title,
        assignee: input.assigneeId ? 'Test User' : null,
        state: 'Todo',
      });
      issues.set(issue.identifier, issue);
      return issue;
    },
    assignedIssues: async () => assigned,
  };
  return Object.assign(api, { control, comments, created, issues, assigned, issueCalls });
}

const slackAuthError = () =>
  Object.assign(new Error('An API error occurred: invalid_auth'), {
    code: 'slack_webapi_platform_error',
    data: { ok: false, error: 'invalid_auth' },
  });

export function fakeSlackApi() {
  const control = { failAuth: false };
  const posts: Array<{ channel: string; text: string; threadTs?: string }> = [];
  const threads = new Map<string, SlackMessage[]>();
  const search: Array<{ channel: string; ts: string; text: string }> = [];
  const reminders: string[] = [];
  let seq = 100;
  const nextTs = () => `1758100000.${String(seq++).padStart(6, '0')}`;
  const push = (key: string, m: SlackMessage) => {
    const list = threads.get(key) ?? [];
    list.push(m);
    threads.set(key, list);
  };
  const api: SlackApi = {
    authTest: async () => {
      if (control.failAuth) throw slackAuthError();
      return { userId: 'U-ME', user: 'me', team: 'Acme' };
    },
    openDm: async () => 'D-ME',
    postMessage: async (channel, text, threadTs) => {
      if (control.failAuth) throw slackAuthError();
      const ts = nextTs();
      posts.push(threadTs ? { channel, text, threadTs } : { channel, text });
      push(threadTs ?? ts, {
        ts,
        user: 'U-ME',
        text,
        botId: null,
        appId: 'A-ORC',
        subtype: null,
        reactions: [],
      });
      return ts;
    },
    replies: async (_channel, threadTs, oldest) =>
      (threads.get(threadTs) ?? []).filter(
        (m) => !oldest || m.ts === threadTs || compareSlackTs(m.ts, oldest) > 0,
      ),
    searchMessages: async () => search,
    addReminder: async (text) => {
      reminders.push(text);
    },
    oauthAccess: async () => ({
      userToken: 'xoxp-from-oauth-123456',
      userId: 'U-ME',
      scopes: ['chat:write', 'im:history'],
    }),
  };
  return Object.assign(api, {
    control,
    posts,
    threads,
    search,
    reminders,
    userReply(threadTs: string, text: string, user = 'U-ME'): string {
      const ts = nextTs();
      push(threadTs, { ts, user, text, botId: null, appId: null, subtype: null, reactions: [] });
      return ts;
    },
    react(ts: string, name: string, user = 'U-ME'): void {
      const root = threads.get(ts)?.find((m) => m.ts === ts);
      if (!root) throw new Error(`no message ${ts}`);
      root.reactions.push({ name, users: [user] });
    },
  });
}

/**
 * `createDaemon({ phase6 })` options that keep Phase 6 inside the process: an in-memory secret
 * store instead of the Keychain, fake Linear and Slack APIs, a push sender that sends nothing, no
 * `ioreg` idle reads and no `tailscale` calls.
 */
export function offlinePhase6(): Phase6Options {
  return {
    secrets: createMemorySecretStore(),
    linearApi: () => fakeLinearApi(),
    slackApi: () => fakeSlackApi(),
    pushSender: async () => ({ statusCode: 201 }),
    idle: async () => null,
    run: async () => '{}',
  };
}
