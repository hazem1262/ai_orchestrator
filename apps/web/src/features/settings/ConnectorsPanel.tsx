import type { ConnectorId, ConnectorStatus } from '@orc/api-contract';
import { useId, useState } from 'react';
import {
  useConnectorAuthorize,
  useConnectors,
  useDisconnectConnector,
  useSetConnectorApp,
  useSetConnectorToken,
} from '@/api/queries/connectors.ts';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';

const INFO: Record<ConnectorId, { name: string; tokenHint: string; help: string }> = {
  linear: {
    name: 'Linear',
    tokenHint: 'lin_api_…',
    help: 'Linear → Settings → Security & access → Personal API keys → New key (read + write). The app acts as you.',
  },
  slack: {
    name: 'Slack',
    tokenHint: 'xoxp-…',
    help: 'Create the “Orchestrator (personal)” Slack app from the manifest in docs/setup-remote-and-connectors.md, install it, then paste the User OAuth Token or use Connect with Slack. The app acts as you.',
  },
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ConnectorsPanel() {
  const { data, isLoading, error } = useConnectors();
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading connectors…</p>;
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load connectors: {errorText(error)}
      </p>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(data ?? []).map((s) => (
        <ConnectorCard key={s.id} status={s} />
      ))}
    </div>
  );
}

function ConnectorCard({ status }: { status: ConnectorStatus }) {
  const id = useId();
  const info = INFO[status.id];
  const [token, setToken] = useState('');
  const [showApp, setShowApp] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const setTok = useSetConnectorToken();
  const setApp = useSetConnectorApp();
  const authorize = useConnectorAuthorize();
  const disconnect = useDisconnectConnector();
  const busy = setTok.isPending || setApp.isPending || authorize.isPending || disconnect.isPending;
  const err = setTok.error ?? setApp.error ?? authorize.error ?? disconnect.error;
  const healthy = status.connected && status.status === 'ok';
  const f = (name: string) => `${id}-${name}`;

  return (
    <section
      aria-label={`${info.name} connector`}
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-4 text-sm"
    >
      <header className="flex items-center justify-between">
        <h3 className="font-semibold">{info.name}</h3>
        <Badge variant={healthy ? 'success' : status.connected ? 'destructive' : 'outline'}>
          {status.connected ? status.status : 'not connected'}
        </Badge>
      </header>

      {status.connected ? (
        <div className="flex flex-col items-start gap-2">
          <p>
            Connected as <strong>{status.accountLabel ?? 'unknown account'}</strong> ({status.authKind})
          </p>
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Disconnect ${info.name}? The token is removed from the Keychain.`)) {
                disconnect.mutate(status.id);
              }
            }}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTok.mutate({ id: status.id, token: token.trim() }, { onSuccess: () => setToken('') });
          }}
        >
          <p className="text-xs text-muted-foreground">{info.help}</p>
          <Label htmlFor={f('token')}>Token</Label>
          <Input
            id={f('token')}
            type="password"
            autoComplete="off"
            placeholder={info.tokenHint}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || token.trim().length < 12}>
              Connect
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !status.oauthConfigured}
              onClick={() =>
                authorize.mutate(status.id, { onSuccess: (r) => window.open(r.url, '_blank', 'noopener') })
              }
            >
              Connect with {info.name}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowApp((v) => !v)}>
              OAuth app…
            </Button>
          </div>
        </form>
      )}

      {showApp ? (
        <form
          className="flex flex-col gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            setApp.mutate(
              { id: status.id, clientId: clientId.trim(), clientSecret: clientSecret.trim() },
              {
                onSuccess: () => {
                  setShowApp(false);
                  setClientSecret('');
                },
              },
            );
          }}
        >
          <Label htmlFor={f('client-id')}>Client ID</Label>
          <Input
            id={f('client-id')}
            autoComplete="off"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
          />
          <Label htmlFor={f('client-secret')}>Client secret</Label>
          <Input
            id={f('client-secret')}
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
          <div>
            <Button
              type="submit"
              size="sm"
              disabled={busy || clientId.trim().length < 5 || clientSecret.trim().length < 10}
            >
              Save OAuth app
            </Button>
          </div>
        </form>
      ) : null}

      {err ? (
        <p role="alert" className="text-destructive">
          {errorText(err)}
        </p>
      ) : null}
    </section>
  );
}
