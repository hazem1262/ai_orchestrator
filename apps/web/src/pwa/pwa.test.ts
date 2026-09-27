import { afterEach, describe, expect, it, vi } from 'vitest';
import { withStepUp } from '../api/step-up.ts';
import {
  clearDeviceToken,
  isLoopbackOrigin,
  readDeviceToken,
  resolveToken,
  setDeviceToken,
} from '../api/token.ts';
import { parsePushPayload, urlBase64ToUint8Array } from './push-payload.ts';

describe('device token', () => {
  afterEach(() => {
    clearDeviceToken();
    window.__ORC_TOKEN__ = undefined;
  });

  it('prefers the injected token and falls back to the paired device token', () => {
    expect(resolveToken()).toBe('');
    setDeviceToken('device-token-1');
    expect(readDeviceToken()).toBe('device-token-1');
    expect(resolveToken()).toBe('device-token-1');
    window.__ORC_TOKEN__ = 'install-token';
    expect(resolveToken()).toBe('install-token');
    window.__ORC_TOKEN__ = null;
    expect(resolveToken()).toBe('device-token-1');
    clearDeviceToken();
    expect(resolveToken()).toBe('');
  });

  it('knows a loopback origin', () => {
    expect(isLoopbackOrigin('127.0.0.1')).toBe(true);
    expect(isLoopbackOrigin('localhost')).toBe(true);
    expect(isLoopbackOrigin('mac.tail1234.ts.net')).toBe(false);
  });
});

describe('withStepUp', () => {
  it('retries once after a passkey assertion', async () => {
    const stepUpError = Object.assign(new Error('confirm with your passkey'), {
      status: 401,
      code: 'step_up_required',
    });
    const fn = vi.fn().mockRejectedValueOnce(stepUpError).mockResolvedValueOnce('ok');
    const stepUp = vi.fn(async () => {});
    await expect(withStepUp(fn, stepUp)).resolves.toBe('ok');
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('passes other errors through and never loops', async () => {
    const other = Object.assign(new Error('nope'), { code: 'not_owned' });
    await expect(withStepUp(vi.fn().mockRejectedValue(other), vi.fn())).rejects.toBe(other);
    const stepUpError = Object.assign(new Error('again'), { code: 'step_up_required' });
    const fn = vi.fn().mockRejectedValue(stepUpError);
    await expect(
      withStepUp(
        fn,
        vi.fn(async () => {}),
      ),
    ).rejects.toBe(stepUpError);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('push payload', () => {
  it('parses payloads defensively', () => {
    expect(
      parsePushPayload(
        JSON.stringify({ title: 'Waiting for you', body: 'b', url: 'https://x/inbox', tag: 't' }),
      ),
    ).toEqual({
      title: 'Waiting for you',
      body: 'b',
      url: 'https://x/inbox',
      tag: 't',
    });
    expect(parsePushPayload(null)).toMatchObject({ title: 'Orchestrator', url: '/inbox' });
    expect(parsePushPayload('not json')).toMatchObject({ title: 'Orchestrator', body: 'not json' });
    expect(parsePushPayload('{"title":5}')).toMatchObject({ title: 'Orchestrator' });
  });

  it('decodes a VAPID key', () => {
    expect(urlBase64ToUint8Array('BPUB-_8')).toBeInstanceOf(Uint8Array);
    expect(urlBase64ToUint8Array('AAAA').length).toBe(3);
  });
});
