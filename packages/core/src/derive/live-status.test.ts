import { describe, expect, it } from 'vitest';
import { deriveLiveStatus, splitPk } from './live-status.ts';
import { emptyTranscriptLive } from './live-transcript.ts';

const t = (over: Partial<ReturnType<typeof emptyTranscriptLive>> = {}) => ({
  ...emptyTranscriptLive(),
  ...over,
});

describe('deriveLiveStatus', () => {
  it('is ended when the process is dead', () => {
    expect(deriveLiveStatus({ alive: false, registryStatus: 'waiting', transcript: t() })).toBe('ended');
  });
  it('passes through busy, waiting and shell', () => {
    expect(
      deriveLiveStatus({ alive: true, registryStatus: 'busy', transcript: t({ lastApiError: 'x' }) }),
    ).toBe('busy');
    expect(deriveLiveStatus({ alive: true, registryStatus: 'waiting', transcript: t() })).toBe('waiting');
    expect(deriveLiveStatus({ alive: true, registryStatus: 'shell', transcript: t() })).toBe('shell');
  });
  it('derives error, review and idle when idle', () => {
    expect(
      deriveLiveStatus({
        alive: true,
        registryStatus: 'idle',
        transcript: t({ lastApiError: 'API Error: 529' }),
      }),
    ).toBe('error');
    expect(
      deriveLiveStatus({
        alive: true,
        registryStatus: 'idle',
        transcript: t({ turnEnded: true, turnChangedFiles: ['a.ts'] }),
      }),
    ).toBe('review');
    expect(
      deriveLiveStatus({
        alive: true,
        registryStatus: 'idle',
        transcript: t({ turnEnded: true, turnPrs: 1 }),
      }),
    ).toBe('review');
    expect(
      deriveLiveStatus({ alive: true, registryStatus: 'idle', transcript: t({ turnEnded: true }) }),
    ).toBe('idle');
    expect(deriveLiveStatus({ alive: true, registryStatus: null, transcript: t() })).toBe('idle');
  });
});

describe('splitPk', () => {
  it('splits on the first colon only', () => {
    expect(splitPk('claude:s-basic')).toEqual({ source: 'claude', id: 's-basic' });
    expect(splitPk('agnc:a:b')).toEqual({ source: 'agnc', id: 'a:b' });
    expect(() => splitPk('bogus')).toThrow(/invalid session pk/);
    expect(() => splitPk('cursor:x')).toThrow(/invalid session pk/);
  });
});
