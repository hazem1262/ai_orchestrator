import type { AgncStatus } from '@orc/api-contract';
import { useAgncConnect, useAgncDisconnect, useAgncStatus } from '@/api/queries/agnc.ts';
import { Badge, type BadgeVariant } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Card } from '@/components/ui/card.tsx';

const STATUS_VARIANT: Record<AgncStatus['status'], BadgeVariant> = {
  ok: 'success',
  unauthenticated: 'warning',
  error: 'destructive',
  disabled: 'outline',
};

const STATUS_LABEL: Record<AgncStatus['status'], string> = {
  ok: 'connected',
  unauthenticated: 'not connected',
  error: 'error',
  disabled: 'off',
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Settings → Connectors: the optional AGNC connection (OAuth in the browser, tokens in the Keychain). */
export function AgncConnectCard({
  openUrl = (u: string) => void window.open(u, '_blank', 'noopener'),
  confirm = (m: string) => window.confirm(m),
}: {
  openUrl?: (url: string) => void;
  confirm?: (message: string) => boolean;
}) {
  const status = useAgncStatus();
  const connect = useAgncConnect();
  const disconnect = useAgncDisconnect();
  const s = status.data;
  const busy = connect.isPending || disconnect.isPending;
  const err = status.error ?? connect.error ?? disconnect.error;

  return (
    <Card aria-label="AGNC connector" className="flex flex-col gap-3 p-4 text-sm">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">AGNC</h3>
        {s ? <Badge variant={STATUS_VARIANT[s.status]}>{STATUS_LABEL[s.status]}</Badge> : null}
      </header>
      {s ? (
        <p className="break-all text-xs text-muted-foreground">
          {s.url} · {s.sessions} remote {s.sessions === 1 ? 'session' : 'sessions'}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Optional. AGNC sessions run remotely and never use a local terminal. Here they are read-only apart
        from the prompt composer, and every prompt or handoff is confirmed before it is sent.
      </p>
      {s?.status === 'disabled' ? (
        <p className="text-xs text-muted-foreground">
          Turned off. Set <code>agnc.enabled</code> to <code>true</code> in the config to use it.
        </p>
      ) : s ? (
        <div className="flex flex-wrap gap-2">
          {s.status === 'ok' ? (
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => {
                if (confirm('Disconnect AGNC? The AGNC tokens are removed from the Keychain.')) {
                  disconnect.mutate();
                }
              }}
            >
              Disconnect AGNC
            </Button>
          ) : null}
          {s.status !== 'ok' ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                connect.mutate(undefined, {
                  onSuccess: (r) => {
                    if (r.authorizationUrl) openUrl(r.authorizationUrl);
                  },
                })
              }
            >
              Connect AGNC
            </Button>
          ) : null}
        </div>
      ) : null}
      {err ? (
        <p role="alert" className="text-xs text-destructive">
          {errorText(err)}
        </p>
      ) : null}
    </Card>
  );
}
