import { describe, expect, it } from 'vitest';
import { fakeLinearApi } from '../../../test/p6-connector-fakes.ts';
import { createMemorySecretStore } from '../../services/secrets/secret-store.ts';
import { ConnectorError } from '../errors.ts';
import { createLinearConnector, toLinearError } from './linear.ts';

function setup(token: string | null = 'lin_api_test_123') {
  const secrets = createMemorySecretStore(token ? { 'linear.token': token } : {});
  const api = fakeLinearApi();
  const tokensSeen: string[] = [];
  let now = 0;
  const linear = createLinearConnector({
    secrets,
    api: (t) => {
      tokensSeen.push(t);
      return api;
    },
    cacheTtlMs: 1000,
    now: () => now,
  });
  return {
    secrets,
    api,
    linear,
    tokensSeen,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('LinearConnector', () => {
  it('reports status', async () => {
    expect(await setup(null).linear.status()).toBe('unauthenticated');
    const s = setup();
    expect(await s.linear.status()).toBe('ok');
    s.api.control.failAuth = true;
    s.linear.invalidate();
    expect(await s.linear.status()).toBe('unauthenticated');
  });

  it('caches issue lookups, including misses, for the TTL', async () => {
    const s = setup();
    expect((await s.linear.issue('saf-1787'))?.identifier).toBe('SAF-1787');
    expect(await s.linear.issue('SAF-1787')).not.toBeNull();
    expect(await s.linear.issue('SAF-9')).toBeNull();
    expect(await s.linear.issue('SAF-9')).toBeNull();
    expect(s.api.issueCalls).toEqual(['SAF-1787', 'SAF-9']);
    s.advance(1001);
    await s.linear.issue('SAF-1787');
    expect(s.api.issueCalls).toEqual(['SAF-1787', 'SAF-9', 'SAF-1787']);
  });

  it('redacts comments and fails for unknown issues', async () => {
    const s = setup();
    await s.linear.comment('SAF-1787', 'done; token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rotated');
    expect(s.api.comments).toEqual([
      { issueId: 'id-SAF-1787', body: 'done; token «redacted:github» rotated' },
    ]);
    await expect(s.linear.comment('SAF-404', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('creates issues in a team, assigned to me when asked', async () => {
    const s = setup();
    const issue = await s.linear.createIssue({
      teamKey: 'SAF',
      title: 'Follow-up',
      description: 'password=hunter2',
      assignToMe: true,
    });
    expect(issue.identifier).toBe('SAF-2001');
    expect(s.api.created).toEqual([
      {
        teamId: 'team-saf',
        title: 'Follow-up',
        description: 'password=«redacted:secret»',
        assigneeId: 'user-1',
      },
    ]);
    await expect(
      s.linear.createIssue({ teamKey: 'NOPE', title: 'x', description: '' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rebuilds the client when the token changes', async () => {
    const s = setup();
    await s.linear.me();
    await s.secrets.set('linear.token', 'lin_api_other_456');
    await s.linear.me();
    expect(s.tokensSeen).toEqual(['lin_api_test_123', 'lin_api_other_456']);
  });

  it('maps SDK errors', () => {
    expect(toLinearError(Object.assign(new Error('x'), { type: 'Forbidden' })).code).toBe('unauthenticated');
    expect(toLinearError(Object.assign(new Error('Entity not found'), { type: 'InvalidInput' })).code).toBe(
      'not_found',
    );
    expect(toLinearError(new Error('socket hang up')).code).toBe('upstream_error');
    const passthrough = new ConnectorError('bad_request', 'x');
    expect(toLinearError(passthrough)).toBe(passthrough);
  });
});
