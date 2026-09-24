import { describe, expect, it } from 'vitest';
import { checkDenied, DEFAULT_DENY_PATTERNS } from './deny-list.ts';
import { compilePattern, firstMatch } from './patterns.ts';

describe('checkDenied with DEFAULT_DENY_PATTERNS', () => {
  it.each([
    'rm -rf /tmp/build',
    'rm -Rf ./dist',
    'rm -r -f node_modules',
    'rm -fr x',
    'git push --force origin main',
    'git push -f',
    'git push --force-with-lease',
    'git reset --hard HEAD~1',
    'git clean -fdx',
    'terraform apply -auto-approve',
    'terraform destroy',
    'kubectl --context=wakecap-prod get pods',
    'kubectl config use-context eks-prod',
    'psql -c "DROP TABLE users"',
    'truncate table events',
    'gh pr merge 231 --squash',
    'helm upgrade api ./chart',
    'please deploy the service',
    'use the production_server_db skill',
  ])('denies %s', (text) => {
    const v = checkDenied(text, DEFAULT_DENY_PATTERNS);
    expect(v.denied).toBe(true);
    expect(v.reason).toMatch(/^matches deny pattern /);
  });

  it.each([
    'git status',
    'git push origin feat/SAF-1787-x-fix',
    'rm -f stale.lock',
    'rm -r build',
    'kubectl --context stage get pods',
    'pnpm vitest run',
    'the deployment doc',
    'firm -rf',
  ])('allows %s', (text) => {
    expect(checkDenied(text, DEFAULT_DENY_PATTERNS)).toEqual({ denied: false, reason: null });
  });

  it('merges extra project patterns', () => {
    expect(checkDenied('run make release', [...DEFAULT_DENY_PATTERNS, 'make\\s+release']).denied).toBe(true);
  });

  it('redacts the matched text inside the reason', () => {
    const v = checkDenied('deploy with password=hunter2', ['password=\\S+']);
    expect(v.reason).not.toContain('hunter2');
    expect(v.reason).toContain('«redacted:secret»');
  });
});

describe('compilePattern', () => {
  it('is case-insensitive and caches', () => {
    expect(compilePattern('abc').test('xABCx')).toBe(true);
    expect(compilePattern('abc')).toBe(compilePattern('abc'));
  });

  it('treats an invalid regex as a literal', () => {
    expect(compilePattern('foo(').test('call foo( now')).toBe(true);
    expect(firstMatch('call foo( now', ['nope', 'foo('])).toEqual({ pattern: 'foo(', match: 'foo(' });
  });
});
