import type { ShareSource } from '@orc/api-contract';
import type { Session } from '@orc/core';
import { Link } from '@tanstack/react-router';
import {
  ChevronDown,
  Download,
  FileDiff,
  GitFork,
  MoreHorizontal,
  Play,
  Send,
  Share2,
  ShieldCheck,
  SquareArrowOutUpRight,
  SquareTerminal,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { HandoffToAgncOutcome, useHandoffToAgnc } from '@/features/agnc/HandoffToAgncButton.tsx';
import { FollowUpDialog } from '@/features/share/FollowUpDialog.tsx';
import { ShareDialog, type ShareTarget } from '@/features/share/ShareDialog.tsx';
import { useResumeRunner } from '@/features/terminal/ResumeActions.tsx';
import { isRemoteSession } from '@/lib/source.ts';
import { useSessionExport } from './session-export.ts';

type ShareOpen =
  | { kind: 'share'; title: string; target: ShareTarget; source: ShareSource }
  | { kind: 'follow-up' }
  | null;

/**
 * The session header's actions: Resume is the one primary button, Review the secondary, and every
 * other action sits in the Share or More menu. Remote (AGNC) sessions get no local-only actions.
 */
export function SessionHeaderActions({ session }: { session: Session }) {
  const remote = isRemoteSession(session);
  return remote ? <RemoteActions session={session} /> : <LocalActions session={session} />;
}

function ReviewButton({ session }: { session: Session }) {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link to="/review/$source/$id" params={{ source: session.source, id: session.id }}>
        <FileDiff aria-hidden />
        Review
      </Link>
    </Button>
  );
}

function RemoteActions({ session }: { session: Session }) {
  const exp = useSessionExport(session.source, session.id);
  return (
    <ActionsFrame status={exp.error ? <Alert>{exp.error}</Alert> : null}>
      <ReviewButton session={session} />
      <MoreMenu>
        <CommonMoreItems session={session} exportBusy={exp.busy} onExport={(u) => void exp.run(u)} />
      </MoreMenu>
    </ActionsFrame>
  );
}

function LocalActions({ session }: { session: Session }) {
  const title = session.name ?? session.firstPrompt ?? session.id;
  const runner = useResumeRunner({
    source: session.source,
    id: session.id,
    availability: session.availability,
    live: session.live,
    title,
  });
  const agnc = useHandoffToAgnc(session);
  const exp = useSessionExport(session.source, session.id);
  const [share, setShare] = useState<ShareOpen>(null);
  const pk = `${session.source}:${session.id}`;
  const ticket = session.tickets[0];
  const toLinear = (t: string, source: ShareSource) =>
    setShare({ kind: 'share', title: t, target: { kind: 'linear-comment', identifier: ticket }, source });

  return (
    <ActionsFrame
      status={
        <>
          {runner.runningElsewhere ? (
            <p className="text-xs text-warning">
              Running in another terminal (pid {runner.live?.pid ?? '?'})
            </p>
          ) : null}
          {runner.message ? (
            <p role="status" className="max-w-md text-right text-xs text-muted-foreground">
              {runner.message}
            </p>
          ) : null}
          {exp.error ? <Alert>{exp.error}</Alert> : null}
          <span className="flex flex-wrap items-center justify-end gap-2 text-xs">
            <HandoffToAgncOutcome handoff={agnc.handoff} />
          </span>
        </>
      }
    >
      <ReviewButton session={session} />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label="Share">
            <Share2 aria-hidden />
            <span className="hidden sm:inline">Share</span>
            <ChevronDown aria-hidden className="hidden sm:block" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Linear</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => toLinear('Recap to Linear', { kind: 'recap', sessionPk: pk })}>
            Recap → Linear
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => toLinear('Handoff to Linear', { kind: 'handoff', sessionPk: pk })}
          >
            Handoff → Linear
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setShare({ kind: 'follow-up' })}>
            Follow-up ticket
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Slack</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() =>
              setShare({
                kind: 'share',
                title: 'Recap to Slack',
                target: { kind: 'slack-post' },
                source: { kind: 'recap', sessionPk: pk },
              })
            }
          >
            Recap → Slack
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <MoreMenu>
        <DropdownMenuItem disabled={runner.unavailable || session.source !== 'claude'} onSelect={runner.fork}>
          <GitFork aria-hidden />
          Fork
        </DropdownMenuItem>
        <DropdownMenuItem disabled={runner.unavailable || runner.runningElsewhere} onSelect={runner.popOut}>
          <SquareArrowOutUpRight aria-hidden />
          Pop out
        </DropdownMenuItem>
        {agnc.available ? (
          <DropdownMenuItem disabled={agnc.handoff.busy} onSelect={() => agnc.start()}>
            <Send aria-hidden />
            Hand off to AGNC
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <CommonMoreItems session={session} exportBusy={exp.busy} onExport={(u) => void exp.run(u)} />
      </MoreMenu>
      {runner.ownedPty ? (
        <Button size="sm" onClick={runner.showTerminal}>
          <SquareTerminal aria-hidden />
          Show terminal
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={runner.unavailable || runner.runningElsewhere}
          title={session.availability !== 'resumable' ? `Not resumable (${session.availability})` : undefined}
          onClick={runner.resume}
        >
          <Play aria-hidden />
          {runner.endedElsewhere ? 'Adopt' : 'Resume'}
        </Button>
      )}
      {share?.kind === 'share' ? (
        <ShareDialog
          title={share.title}
          target={share.target}
          source={share.source}
          onClose={() => setShare(null)}
        />
      ) : null}
      {share?.kind === 'follow-up' ? (
        <FollowUpDialog
          sessionPk={pk}
          defaultTitle={`Follow-up: ${session.name ?? ticket ?? 'session'}`}
          onClose={() => setShare(null)}
        />
      ) : null}
    </ActionsFrame>
  );
}

function ActionsFrame({ children, status }: { children: React.ReactNode; status: React.ReactNode }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">{children}</div>
      {status}
    </div>
  );
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-xs text-destructive">
      {children}
    </p>
  );
}

function MoreMenu({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="More actions">
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CommonMoreItems({
  session,
  exportBusy,
  onExport,
}: {
  session: Session;
  exportBusy: boolean;
  onExport: (unredacted: boolean) => void;
}) {
  return (
    <>
      <DropdownMenuItem asChild>
        <a href={`/audit?sessionPk=${encodeURIComponent(`${session.source}:${session.id}`)}`}>
          <ShieldCheck aria-hidden />
          Audit log
        </a>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={exportBusy} onSelect={() => onExport(false)}>
        <Download aria-hidden />
        Export ZIP
      </DropdownMenuItem>
      <DropdownMenuItem disabled={exportBusy} onSelect={() => onExport(true)}>
        <Download aria-hidden />
        Export ZIP with secrets (unredacted)
      </DropdownMenuItem>
    </>
  );
}
