import { type Issue, LinearClient } from '@linear/sdk';
import type { LinearIssue } from '@orc/api-contract';

export interface LinearViewer {
  id: string;
  name: string;
  email: string;
}

export interface LinearApi {
  viewer(): Promise<LinearViewer>;
  issue(identifier: string): Promise<LinearIssue | null>;
  createComment(issueId: string, body: string): Promise<void>;
  teamIdByKey(key: string): Promise<string | null>;
  createIssue(input: {
    teamId: string;
    title: string;
    description: string;
    assigneeId?: string;
  }): Promise<LinearIssue>;
  assignedIssues(first: number): Promise<LinearIssue[]>;
}

async function toIssue(i: Issue): Promise<LinearIssue> {
  const [state, assignee, labels] = await Promise.all([i.state, i.assignee, i.labels({ first: 20 })]);
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    state: state?.name ?? 'Unknown',
    assignee: assignee?.name ?? null,
    url: i.url,
    labels: labels.nodes.map((l) => l.name),
  };
}

const isNotFound = (e: unknown) =>
  /not found|could not find/i.test(e instanceof Error ? e.message : String(e));

export function createLinearSdkApi(token: string): LinearApi {
  const client = token.startsWith('lin_api_')
    ? new LinearClient({ apiKey: token })
    : new LinearClient({ accessToken: token });
  return {
    async viewer() {
      const v = await client.viewer;
      return { id: v.id, name: v.name, email: v.email };
    },
    async issue(identifier) {
      try {
        return await toIssue(await client.issue(identifier));
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },
    async createComment(issueId, body) {
      const r = await client.createComment({ issueId, body });
      if (!r.success) throw new Error('Linear rejected the comment');
    },
    async teamIdByKey(key) {
      const teams = await client.teams({ filter: { key: { eq: key } }, first: 1 });
      return teams.nodes[0]?.id ?? null;
    },
    async createIssue(input) {
      const r = await client.createIssue(input);
      const issue = await r.issue;
      if (!r.success || !issue) throw new Error('Linear did not create the issue');
      return toIssue(issue);
    },
    async assignedIssues(first) {
      const me = await client.viewer;
      const page = await me.assignedIssues({
        first,
        filter: { state: { type: { nin: ['completed', 'canceled'] } } },
      });
      return Promise.all(page.nodes.map(toIssue));
    },
  };
}
