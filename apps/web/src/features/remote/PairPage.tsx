import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { startRegistration } from '@simplewebauthn/browser';
import { useId, useState } from 'react';
import { getApiClient, resetApiClient } from '@/api/client.ts';
import { setDeviceToken } from '@/api/token.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { enablePush, type PushSetupResult } from '@/pwa/push.ts';

type Step = 'code' | 'passkey' | 'push' | 'done';

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
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName);
  const [step, setStep] = useState<Step>('code');
  const [pushResult, setPushResult] = useState<PushSetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeId = useId();
  const nameId = useId();

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

  return (
    <main className="mx-auto max-w-sm space-y-4 p-4">
      <h1 className="text-xl font-semibold">Pair this device</h1>
      {step === 'code' && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void guard(async () => {
              const r = await getApiClient().remotePair(code.trim().toUpperCase(), name.trim());
              setDeviceToken(r.deviceToken);
              resetApiClient();
              setStep('passkey');
            });
          }}
        >
          <p className="text-sm text-muted-foreground">
            On the Mac, open Settings → Remote and create a pairing code.
          </p>
          <label htmlFor={codeId} className="block text-sm">
            Pairing code
          </label>
          <Input
            id={codeId}
            className="h-11 w-full text-lg uppercase tracking-widest"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <label htmlFor={nameId} className="block text-sm">
            Device name
          </label>
          <Input id={nameId} className="h-10 w-full" value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" disabled={busy || code.trim().length !== 8 || name.trim() === ''}>
            Pair this device
          </Button>
        </form>
      )}
      {step === 'passkey' && (
        <div className="space-y-3">
          <p className="text-sm">
            Paired. Now create a passkey — it is required to send input, approve, stop or merge from here.
          </p>
          <Button
            disabled={busy}
            onClick={() =>
              void guard(async () => {
                await registerPasskey();
                setStep('push');
              })
            }
          >
            Create passkey
          </Button>
        </div>
      )}
      {step === 'push' && (
        <div className="space-y-3">
          <p className="text-sm">
            Allow notifications so the inbox can reach you. On iOS, add this app to the Home Screen first.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={() =>
                void guard(async () => {
                  setPushResult(await setupPush());
                  setStep('done');
                })
              }
            >
              Enable notifications
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setStep('done')}>
              Skip
            </Button>
          </div>
        </div>
      )}
      {step === 'done' && (
        <div className="space-y-3">
          <p className="text-sm">{doneMessage(pushResult)}</p>
          <a className="underline" href="/inbox">
            Open the inbox
          </a>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </main>
  );
}
