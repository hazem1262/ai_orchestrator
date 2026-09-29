import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { startRegistration } from '@simplewebauthn/browser';
import { Bell, Check, CheckCircle2, KeyRound, Link2, Loader2, Smartphone } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { getApiClient, resetApiClient } from '@/api/client.ts';
import { useRemoteStatus } from '@/api/queries/remote.ts';
import { setDeviceToken } from '@/api/token.ts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card.tsx';
import { cn } from '@/components/ui/cn.ts';
import { Input } from '@/components/ui/input.tsx';
import { Skeleton } from '@/components/ui/skeleton.tsx';
import { enablePush, type PushSetupResult } from '@/pwa/push.ts';
import { CodeBoxes } from './CodeBoxes.tsx';

type Step = 'code' | 'passkey' | 'push' | 'done';

const CODE_LENGTH = 8;

const STEPS: Array<{ id: Exclude<Step, 'done'>; label: string; icon: typeof Link2 }> = [
  { id: 'code', label: 'Pair', icon: Link2 },
  { id: 'passkey', label: 'Passkey', icon: KeyRound },
  { id: 'push', label: 'Notifications', icon: Bell },
];

export function defaultDeviceName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Device';
}

async function registerPasskeyDefault(): Promise<void> {
  const api = getApiClient();
  const optionsJSON = await api.webauthnRegisterOptions<PublicKeyCredentialCreationOptionsJSON>();
  const attestation = await startRegistration({ optionsJSON });
  await api.webauthnRegisterVerify(attestation);
}

function doneMessage(pushResult: PushSetupResult | null): string {
  if (pushResult === 'subscribed') return 'This device is ready and notifications are on.';
  if (pushResult) return `This device is ready (notifications: ${pushResult}).`;
  return 'This device is ready.';
}

export function PairPage({
  registerPasskey = registerPasskeyDefault,
  setupPush = enablePush,
}: {
  registerPasskey?: () => Promise<void>;
  setupPush?: () => Promise<PushSetupResult>;
} = {}) {
  const remoteStatus = useRemoteStatus();
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName);
  const [step, setStep] = useState<Step>('code');
  const [pushResult, setPushResult] = useState<PushSetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeId = useId();
  const nameId = useId();
  const stepIndex = STEPS.findIndex((s) => s.id === step);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function submitCode(e: FormEvent) {
    e.preventDefault();
    const normalizedCode = code.trim().toUpperCase();
    const trimmedName = name.trim();
    if (normalizedCode.length !== CODE_LENGTH) {
      setError(`Enter all ${CODE_LENGTH} characters of the code.`);
      return;
    }
    if (trimmedName === '') {
      setError('Enter a device name.');
      return;
    }
    void guard(async () => {
      const r = await getApiClient().remotePair(normalizedCode, trimmedName);
      setDeviceToken(r.deviceToken);
      resetApiClient();
      setStep('passkey');
    });
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Pair this device</h1>

      {remoteStatus.isLoading ? (
        <Card aria-busy="true" aria-label="Checking remote access">
          <CardHeader className="gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-9 w-full" />
          </CardContent>
        </Card>
      ) : remoteStatus.data && !remoteStatus.data.enabled ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Smartphone className="size-5 text-muted-foreground" aria-hidden />
              <CardTitle>Remote access is off</CardTitle>
            </div>
            <CardDescription>
              On the Mac, open Settings → Remote &amp; mobile and allow remote access. Then create a pairing
              code there.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Button asChild size="sm" variant="outline">
              <a href="/settings?section=remote">Open remote settings</a>
            </Button>
          </CardFooter>
        </Card>
      ) : (
        <>
          {step !== 'done' && (
            <ol aria-label="Pairing steps" className="grid grid-cols-3 gap-2">
              {STEPS.map((s, i) => {
                const done = i < stepIndex;
                const active = i === stepIndex;
                return (
                  <li
                    key={s.id}
                    aria-current={active ? 'step' : undefined}
                    className={cn(
                      'flex flex-col gap-1.5 text-xs',
                      active ? 'text-foreground' : 'text-muted-foreground',
                    )}
                  >
                    <span className={cn('h-1 rounded-full', done || active ? 'bg-primary' : 'bg-muted')} />
                    <span className="flex items-center gap-1">
                      {done ? (
                        <Check className="size-3.5" aria-hidden />
                      ) : (
                        <s.icon className="size-3.5" aria-hidden />
                      )}
                      {s.label}
                      {done && <span className="sr-only">(done)</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {step === 'code' && (
            <Card>
              <form onSubmit={submitCode} className="contents">
                <CardHeader>
                  <CardTitle>Enter the pairing code</CardTitle>
                  <CardDescription>
                    On the Mac, open Settings → Remote and create a pairing code.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <span id={codeId} className="text-sm">
                      Pairing code
                    </span>
                    <CodeBoxes
                      id={codeId}
                      length={CODE_LENGTH}
                      value={code}
                      onChange={setCode}
                      groupLabel="Pairing code"
                      disabled={busy}
                      invalid={!!error}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={nameId} className="text-sm">
                      Device name
                    </label>
                    <Input
                      id={nameId}
                      className="h-10 w-full"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={busy}
                    />
                  </div>
                </CardContent>
                <CardFooter>
                  <Button type="submit" size="lg" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="animate-spin" aria-hidden />}
                    Pair this device
                  </Button>
                </CardFooter>
              </form>
            </Card>
          )}

          {step === 'passkey' && (
            <Card>
              <CardHeader>
                <CardTitle>Create a passkey</CardTitle>
                <CardDescription>
                  Paired. Now create a passkey — it is required to send input, approve, stop or merge from
                  here.
                </CardDescription>
              </CardHeader>
              <CardFooter>
                <Button
                  size="lg"
                  className="w-full"
                  disabled={busy}
                  onClick={() =>
                    void guard(async () => {
                      await registerPasskey();
                      setStep('push');
                    })
                  }
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
                  Create passkey
                </Button>
              </CardFooter>
            </Card>
          )}

          {step === 'push' && (
            <Card>
              <CardHeader>
                <CardTitle>Allow notifications</CardTitle>
                <CardDescription>
                  So the inbox can reach you. On iOS, add this app to the Home Screen first.
                </CardDescription>
              </CardHeader>
              <CardFooter className="flex-col gap-2">
                <Button
                  size="lg"
                  className="w-full"
                  disabled={busy}
                  onClick={() =>
                    void guard(async () => {
                      setPushResult(await setupPush());
                      setStep('done');
                    })
                  }
                >
                  {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Bell aria-hidden />}
                  Enable notifications
                </Button>
                <Button
                  variant="ghost"
                  size="lg"
                  className="w-full"
                  disabled={busy}
                  onClick={() => setStep('done')}
                >
                  Skip
                </Button>
              </CardFooter>
            </Card>
          )}

          {step === 'done' && (
            <Alert>
              <CheckCircle2 className="text-success" aria-hidden />
              <AlertTitle>This device is ready</AlertTitle>
              <AlertDescription>
                <p>{doneMessage(pushResult)}</p>
                <Button asChild size="sm" className="mt-2">
                  <a href="/inbox">Open the inbox</a>
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t pair</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </main>
  );
}
