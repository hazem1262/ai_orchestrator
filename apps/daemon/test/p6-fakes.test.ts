import { afterEach, describe, expect, it } from 'vitest';
import { actorScope } from '../src/services/audit/actor-scope.ts';
import { useTempHomes } from './helpers.ts';
import { makeInboxItem, p6Context } from './p6-fakes.ts';

describe('p6 fakes', () => {
  useTempHomes();
  const disposers: Array<() => void> = [];
  afterEach(() => {
    for (const d of disposers.splice(0)) d();
  });

  it('audits pty input with the actor from actorScope', async () => {
    const { ctx, rawPty, audit } = p6Context();
    disposers.push(() => ctx.dispose());
    await actorScope.run({ actor: 'remote', actorDetail: 'Phone (me@example.com)' }, () =>
      ctx.pty.sendText('pty-1', 'yes'),
    );
    await ctx.pty.sendText('pty-1', 'local');
    expect(rawPty.sent.map((s) => s.text)).toEqual(['yes', 'local']);
    const entries = audit.list({ action: 'pty.input' });
    expect(entries.map((e) => e.actor).sort()).toEqual(['remote', 'user']);
    expect(entries.find((e) => e.actor === 'remote')?.actorDetail).toBe('Phone (me@example.com)');
  });

  it('emits inbox.upserted on state changes', () => {
    const { ctx, inbox } = p6Context({ inbox: [makeInboxItem({ id: 'i1' })] });
    disposers.push(() => ctx.dispose());
    const seen: string[] = [];
    ctx.bus.on('inbox.upserted', (e) => seen.push(e.item.state));
    inbox.markDone('i1');
    expect(seen).toEqual(['done']);
  });
});
