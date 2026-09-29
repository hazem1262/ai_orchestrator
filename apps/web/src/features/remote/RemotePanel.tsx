import { type AwayMode, RemoteConfigBody, type RemoteDevice, type RemoteStatus } from '@orc/api-contract';
import { OctagonAlert, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { getApiClient } from '@/api/client.ts';
import {
  useAway,
  useCreatePairingCode,
  useRemoteDevices,
  useRemoteStatus,
  useRevokeDevice,
  useSaveRemoteConfig,
  useSetAway,
} from '@/api/queries/remote.ts';
import { Alert, AlertDescription } from '@/components/ui/alert.tsx';
import { Badge } from '@/components/ui/badge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Input } from '@/components/ui/input.tsx';
import { Label } from '@/components/ui/label.tsx';
import { Separator } from '@/components/ui/separator.tsx';
import { formatDateTime } from '@/lib/format.ts';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const AWAY_BUTTONS: Array<{ mode: AwayMode; label: string }> = [
  { mode: 'auto', label: 'Automatic' },
  { mode: 'on', label: 'Away now' },
  { mode: 'off', label: 'At the Mac' },
];

export function RemotePanel() {
  const status = useRemoteStatus();
  const s = status.data;
  return (
    <div className="flex flex-col gap-4 text-sm">
      {s?.funnelDetected && (
        <Alert variant="destructive" className="border-destructive/50">
          <OctagonAlert aria-hidden />
          <AlertDescription>
            Tailscale Funnel is enabled, so remote access is blocked. Run{' '}
            <code className="font-mono">tailscale funnel --https=443 off</code>.
          </AlertDescription>
        </Alert>
      )}
      {status.error && (
        <p role="alert" className="text-destructive">
          Could not load remote status: {errorText(status.error)}
        </p>
      )}
      {status.isLoading && <p className="text-muted-foreground">Loading remote status…</p>}
      {s && <StatusLine status={s} />}
      {s && <ConfigForm key={`${s.enabled}|${s.origin}|${s.allowedLogin}`} status={s} />}
      <Separator />
      <PairingSection enabled={s?.enabled ?? false} />
      <Separator />
      <DevicesSection />
      <Separator />
      <AwaySection />
      <Separator />
      <p className="text-muted-foreground">
        Setup steps are in <span className="font-mono">docs/setup-remote-and-connectors.md</span>. Never run{' '}
        <code className="font-mono">tailscale funnel</code>: it would expose the app to the internet.
      </p>
    </div>
  );
}

function StatusLine({ status: s }: { status: RemoteStatus }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="flex flex-wrap items-center gap-2">
        Remote access is{' '}
        <Badge variant={s.enabled && s.allowedLogin ? 'success' : 'outline'}>
          {s.enabled ? 'on' : 'off'}
        </Badge>
        <span className="break-all">{s.origin ? `at ${s.origin}` : '(no Tailscale origin set)'}</span>
      </p>
      <p className="text-muted-foreground">
        Allowed Tailscale login: <strong className="text-foreground">{s.allowedLogin ?? 'not set'}</strong>
      </p>
      {s.enabled && !s.allowedLogin && (
        <Alert role="status" className="border-warning/40 bg-warning/10">
          <TriangleAlert aria-hidden className="text-warning" />
          <AlertDescription className="text-pretty text-foreground">
            Remote requests stay denied until an allowed Tailscale login is set. The tailnet is shared with
            other devices, so only this one login may reach the app.
          </AlertDescription>
        </Alert>
      )}
      {s.isRemote && (
        <p className="text-muted-foreground">
          You are on a paired device
          {s.stepUpValidUntil ? `; passkey confirmed until ${formatDateTime(s.stepUpValidUntil)}` : ''}.
        </p>
      )}
    </div>
  );
}

function ConfigForm({ status: s }: { status: RemoteStatus }) {
  const id = useId();
  const save = useSaveRemoteConfig();
  const [enabled, setEnabled] = useState(s.enabled);
  const [origin, setOrigin] = useState(s.origin ?? '');
  const [login, setLogin] = useState(s.allowedLogin ?? '');
  const [invalid, setInvalid] = useState<string | null>(null);

  return (
    <form
      aria-label="Remote access configuration"
      className="grid gap-3 md:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        const body = RemoteConfigBody.safeParse({
          enabled,
          origin: origin.trim() || null,
          allowedLogin: login.trim() || null,
        });
        if (!body.success) {
          const field = body.error.issues[0]?.path[0];
          setInvalid(
            field === 'origin'
              ? 'The origin must look like https://mac.tail1234.ts.net'
              : 'The Tailscale login must be 3 to 200 characters',
          );
          return;
        }
        setInvalid(null);
        save.mutate(body.data);
      }}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor={`${id}-origin`}>Tailscale origin</Label>
        <Input
          id={`${id}-origin`}
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          placeholder="https://mac.tail1234.ts.net"
          autoComplete="off"
        />
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <Label htmlFor={`${id}-login`}>Allowed Tailscale login</Label>
        <Input
          id={`${id}-login`}
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="me@example.com"
          autoComplete="off"
        />
        <span className="text-xs text-muted-foreground">
          Only requests from this Tailscale user are let in. Leave it empty to keep remote access denied.
        </span>
      </div>
      <div className="flex items-center gap-2 md:col-span-2">
        <Checkbox id={`${id}-enabled`} checked={enabled} onCheckedChange={setEnabled} />
        <Label htmlFor={`${id}-enabled`}>Allow remote access over Tailscale</Label>
      </div>
      <div className="flex items-center gap-2 md:col-span-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save remote settings
        </Button>
        {save.isSuccess && !save.isPending && <span className="text-xs text-muted-foreground">Saved.</span>}
      </div>
      {(invalid || save.error) && (
        <p role="alert" className="text-destructive md:col-span-2">
          {invalid ?? errorText(save.error)}
        </p>
      )}
    </form>
  );
}

function PairingSection({ enabled }: { enabled: boolean }) {
  const pairing = useCreatePairingCode();
  return (
    <section aria-label="Pairing" className="flex flex-col gap-2">
      <h3 className="font-semibold">Pair a phone</h3>
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={!enabled || pairing.isPending}
          onClick={() => pairing.mutate()}
        >
          Create pairing code
        </Button>
      </div>
      {!enabled && <p className="text-muted-foreground">Turn remote access on to pair a device.</p>}
      {pairing.data && (
        <div className="rounded-md border p-3">
          <p className="font-mono text-2xl tracking-widest">{pairing.data.code}</p>
          <p className="text-muted-foreground">Valid until {formatDateTime(pairing.data.expiresAt)}.</p>
          {pairing.data.url ? (
            <p className="text-muted-foreground">
              On the phone open{' '}
              <span className="break-all font-mono text-foreground">{pairing.data.url}</span>
            </p>
          ) : (
            <p className="text-muted-foreground">Set the Tailscale origin to get a pairing link.</p>
          )}
        </div>
      )}
      {pairing.error && (
        <p role="alert" className="text-destructive">
          {errorText(pairing.error)}
        </p>
      )}
    </section>
  );
}

function DevicesSection() {
  const devices = useRemoteDevices();
  const revoke = useRevokeDevice();
  const list = devices.data ?? [];
  return (
    <section aria-label="Paired devices" className="flex flex-col gap-2">
      <h3 className="font-semibold">Paired devices</h3>
      {devices.error && (
        <p role="alert" className="text-destructive">
          Could not load devices: {errorText(devices.error)}
        </p>
      )}
      {devices.isSuccess && list.length === 0 && (
        <p className="text-muted-foreground">No devices paired yet.</p>
      )}
      {list.map((d: RemoteDevice) => (
        <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
          <span>
            <strong>{d.name}</strong>
            {d.login ? ` · ${d.login}` : ''} · {d.credentials} passkey{d.credentials === 1 ? '' : 's'} ·{' '}
            {d.revokedAt ? 'revoked' : `last seen ${d.lastSeenAt ? formatDateTime(d.lastSeenAt) : 'never'}`}
          </span>
          {!d.revokedAt && (
            <Button
              size="sm"
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Revoke ${d.name}? It loses access, its passkeys and its push subscriptions.`,
                  )
                ) {
                  revoke.mutate(d.id);
                }
              }}
            >
              Revoke {d.name}
            </Button>
          )}
        </div>
      ))}
      {revoke.error && (
        <p role="alert" className="text-destructive">
          {errorText(revoke.error)}
        </p>
      )}
    </section>
  );
}

function AwaySection() {
  const away = useAway();
  const setAway = useSetAway();
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const a = away.data;
  return (
    <section aria-label="Away mode" className="flex flex-col gap-2">
      <h3 className="font-semibold">Away mode</h3>
      {a && (
        <p className="text-muted-foreground">
          {a.away ? 'Away' : 'At the Mac'} · mode {a.mode} · reason {a.reason}
          {a.idleSeconds === null ? '' : ` · idle ${a.idleSeconds}s`}
        </p>
      )}
      {away.error && (
        <p role="alert" className="text-destructive">
          Could not load away mode: {errorText(away.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {AWAY_BUTTONS.map((b) => (
          <Button
            key={b.mode}
            size="sm"
            variant={a?.mode === b.mode ? 'default' : 'outline'}
            aria-pressed={a?.mode === b.mode}
            disabled={setAway.isPending}
            onClick={() => setAway.mutate(b.mode)}
          >
            {b.label}
          </Button>
        ))}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setPushMessage(null);
            void getApiClient()
              .pushTest()
              .then((r) => setPushMessage(`Test push sent to ${r.sent} device(s).`))
              .catch((e: unknown) => setPushMessage(errorText(e)));
          }}
        >
          Send test push
        </Button>
      </div>
      {pushMessage && <p className="text-muted-foreground">{pushMessage}</p>}
      {setAway.error && (
        <p role="alert" className="text-destructive">
          {errorText(setAway.error)}
        </p>
      )}
    </section>
  );
}
