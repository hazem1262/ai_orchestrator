import { describe, expect, it } from 'vitest';
import { listAllSessions, loadEvents } from '../src/services/session-pages.ts';
import { ev, makeP5Context, makeSession, withWakecap } from './p5-helpers.ts';

describe('p5 helpers', () => {
  it('fake sessions page, filter and emit on setLive', () => {
    const sessions = Array.from({ length: 450 }, (_, i) =>
      makeSession({
        id: `s${i}`,
        lastActivityAt: `2026-09-01T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
      }),
    );
    const { ctx } = makeP5Context({ config: withWakecap('/Users/test/Wakecap'), data: { sessions } });
    expect(listAllSessions(ctx, { projectId: 'wakecap' })).toHaveLength(450);
    const seen: string[] = [];
    ctx.bus.on('session.updated', (e) => seen.push(e.session.id));
    ctx.sessions.setLive('claude:s1', null);
    expect(seen).toEqual(['s1']);
  });

  it('loads events across pages for the main transcript only', () => {
    const events = [
      ...Array.from({ length: 1500 }, (_, i) =>
        ev({ seq: i + 1, ts: '2026-09-01T10:00:00.000Z', kind: 'assistant_text' }),
      ),
      ev({ seq: 1, ts: '2026-09-01T10:00:00.000Z', kind: 'prompt', agentId: 'ag1' }),
    ];
    const { ctx } = makeP5Context({
      config: withWakecap('/Users/test/Wakecap'),
      data: { sessions: [makeSession({ id: 'a' })], events: { 'claude:a': events } },
    });
    expect(loadEvents(ctx, { source: 'claude', id: 'a' }, null)).toHaveLength(1500);
    expect(loadEvents(ctx, { source: 'claude', id: 'a' }, 'ag1')).toHaveLength(1);
  });

  it('resolves projects from the overridden config and exposes a token', () => {
    const { ctx, headers } = makeP5Context({ config: withWakecap('/Users/test/Wakecap') });
    expect(ctx.projects.resolve('/Users/test/Wakecap/Backend/svc')).toBe('wakecap');
    expect(ctx.projects.get('wakecap')?.features.workStreams).toBe(true);
    expect(headers['x-orc-token']).toBeTruthy();
    const next = ctx.updateConfig?.((c) => ({ ...c, recaps: { ...c.recaps, enabled: true } }));
    expect(next?.recaps.enabled).toBe(true);
    expect(ctx.config().recaps.enabled).toBe(true);
  });
});
