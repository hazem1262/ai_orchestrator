export interface CreateWorktreeInput {
  repo: string;
  base: string;
  type: 'feat' | 'fix' | 'chore' | 'docs' | 'refactor';
  ticket: string | null;
  slug: string;
}
