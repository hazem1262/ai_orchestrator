import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FakePr {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  /** true = someone else's PR that requests my review (returned only by `search prs --review-requested=@me`) */
  reviewRequested?: boolean;
  headRefName: string;
  baseRefName: string;
  body: string;
  updatedAt: string;
  reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
  statusCheckRollup: Array<
    | { __typename: 'CheckRun'; name: string; status: string; conclusion: string }
    | { __typename: 'StatusContext'; context: string; state: string }
  >;
}
export interface FakeGhState {
  authed: boolean;
  repo: string;
  nextNumber: number;
  prs: Record<string, FakePr>;
}
export interface FakeGh {
  dir: string;
  state(): FakeGhState;
  setState(patch: Partial<FakeGhState>): void;
  setPr(pr: FakePr): void;
  calls(): string[][];
  restore(): void;
}

const BIN = fileURLToPath(new URL('./bin', import.meta.url));

export function useFakeGh(initial: Partial<FakeGhState> = {}): FakeGh {
  const dir = mkdtempSync(join(tmpdir(), 'orc-gh-'));
  const statePath = join(dir, 'state.json');
  const write = (s: FakeGhState) => writeFileSync(statePath, JSON.stringify(s, null, 2));
  write({ authed: true, repo: 'example-org/temp-repo', nextNumber: 101, prs: {}, ...initial });
  writeFileSync(join(dir, 'calls.jsonl'), '');
  const prevPath = process.env.PATH;
  const prevDir = process.env.FAKE_GH_DIR;
  process.env.PATH = `${BIN}${delimiter}${prevPath ?? ''}`;
  process.env.FAKE_GH_DIR = dir;
  const read = (): FakeGhState => JSON.parse(readFileSync(statePath, 'utf8')) as FakeGhState;
  return {
    dir,
    state: read,
    setState: (patch) => write({ ...read(), ...patch }),
    setPr: (pr) => {
      const s = read();
      s.prs[`${pr.repo}#${pr.number}`] = pr;
      write(s);
    },
    calls: () =>
      readFileSync(join(dir, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as string[]),
    restore: () => {
      process.env.PATH = prevPath;
      if (prevDir === undefined) delete process.env.FAKE_GH_DIR;
      else process.env.FAKE_GH_DIR = prevDir;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
