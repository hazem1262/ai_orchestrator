import { WebClient } from '@slack/web-api';

export interface SlackMessage {
  ts: string;
  user: string | null;
  text: string;
  botId: string | null;
  appId: string | null;
  subtype: string | null;
  reactions: Array<{ name: string; users: string[] }>;
}

export interface SlackApi {
  authTest(): Promise<{ userId: string; user: string; team: string }>;
  openDm(userId: string): Promise<string>;
  postMessage(channel: string, text: string, threadTs?: string): Promise<string>;
  replies(channel: string, threadTs: string, oldest?: string): Promise<SlackMessage[]>;
  searchMessages(query: string, count: number): Promise<Array<{ channel: string; ts: string; text: string }>>;
  addReminder(text: string, time: number): Promise<void>;
  oauthAccess(i: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<{
    userToken: string;
    userId: string;
    scopes: string[];
  }>;
}

export function createSlackWebApi(token: string | null): SlackApi {
  const client = token ? new WebClient(token) : new WebClient();
  return {
    async authTest() {
      const r = await client.auth.test();
      if (!r.user_id) throw new Error('Slack auth.test returned no user');
      return { userId: r.user_id, user: r.user ?? '', team: r.team ?? '' };
    },
    async openDm(userId) {
      const r = await client.conversations.open({ users: userId });
      const id = r.channel?.id;
      if (!id) throw new Error('Slack did not return a DM channel');
      return id;
    },
    async postMessage(channel, text, threadTs) {
      const r = threadTs
        ? await client.chat.postMessage({
            channel,
            text,
            thread_ts: threadTs,
            unfurl_links: false,
            unfurl_media: false,
          })
        : await client.chat.postMessage({ channel, text, unfurl_links: false, unfurl_media: false });
      if (!r.ts) throw new Error('Slack did not return a message timestamp');
      return r.ts;
    },
    async replies(channel, threadTs, oldest) {
      const r = await client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 200,
        ...(oldest ? { oldest } : {}),
      });
      return (r.messages ?? []).map((m) => ({
        ts: m.ts ?? '',
        user: m.user ?? null,
        text: m.text ?? '',
        botId: m.bot_id ?? null,
        appId: m.app_id ?? null,
        subtype: (m as { subtype?: string }).subtype ?? null,
        reactions: (m.reactions ?? []).map((x) => ({ name: x.name ?? '', users: x.users ?? [] })),
      }));
    },
    async searchMessages(query, count) {
      const r = await client.search.messages({ query, count, sort: 'timestamp', sort_dir: 'desc' });
      return (r.messages?.matches ?? [])
        .map((m) => ({ channel: m.channel?.id ?? '', ts: m.ts ?? '', text: m.text ?? '' }))
        .filter((m) => m.channel !== '' && m.ts !== '');
    },
    async addReminder(text, time) {
      await client.reminders.add({ text, time });
    },
    async oauthAccess(i) {
      const r = await client.oauth.v2.access({
        client_id: i.clientId,
        client_secret: i.clientSecret,
        code: i.code,
        redirect_uri: i.redirectUri,
      });
      const u = r.authed_user;
      if (!u?.access_token || !u.id)
        throw new Error('Slack did not return a user token (check the user scopes)');
      return {
        userToken: u.access_token,
        userId: u.id,
        scopes: (u.scope ?? '').split(',').filter((s) => s !== ''),
      };
    },
  };
}
