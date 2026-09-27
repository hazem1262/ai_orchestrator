import type { LinearIssue } from '@orc/api-contract';
import type { LinearApi } from '../src/connectors/linear/api.ts';

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
