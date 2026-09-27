import type { ShareSource } from '@orc/api-contract';
import type { Session } from '@orc/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { FollowUpDialog } from './FollowUpDialog.tsx';
import { ShareDialog, type ShareTarget } from './ShareDialog.tsx';

type Open =
  | { kind: 'share'; title: string; target: ShareTarget; source: ShareSource }
  | { kind: 'follow-up' }
  | null;

export function SessionShareActions({ session }: { session: Session }) {
  const pk = `${session.source}:${session.id}`;
  const ticket = session.tickets[0];
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const toLinear = (title: string, source: ShareSource) =>
    setOpen({ kind: 'share', title, target: { kind: 'linear-comment', identifier: ticket }, source });
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        onClick={() => toLinear('Recap to Linear', { kind: 'recap', sessionPk: pk })}
      >
        Recap → Linear
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => toLinear('Handoff to Linear', { kind: 'handoff', sessionPk: pk })}
      >
        Handoff → Linear
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          setOpen({
            kind: 'share',
            title: 'Recap to Slack',
            target: { kind: 'slack-post' },
            source: { kind: 'recap', sessionPk: pk },
          })
        }
      >
        Recap → Slack
      </Button>
      <Button size="sm" variant="outline" onClick={() => setOpen({ kind: 'follow-up' })}>
        Follow-up ticket
      </Button>
      {open?.kind === 'share' ? (
        <ShareDialog title={open.title} target={open.target} source={open.source} onClose={close} />
      ) : null}
      {open?.kind === 'follow-up' ? (
        <FollowUpDialog
          sessionPk={pk}
          defaultTitle={`Follow-up: ${session.name ?? ticket ?? 'session'}`}
          onClose={close}
        />
      ) : null}
    </div>
  );
}
