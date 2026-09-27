import { isApiErrorWithCode } from '@orc/api-contract';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { startAuthentication } from '@simplewebauthn/browser';
import { getApiClient } from './client.ts';

export async function performStepUp(): Promise<void> {
  const api = getApiClient();
  const optionsJSON = await api.webauthnStepUpOptions<PublicKeyCredentialRequestOptionsJSON>();
  const assertion = await startAuthentication({ optionsJSON });
  await api.webauthnStepUpVerify(assertion);
}

/** Runs `fn`; on `step_up_required` it asks for the passkey once and retries exactly once. */
export async function withStepUp<T>(
  fn: () => Promise<T>,
  stepUp: () => Promise<void> = performStepUp,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isApiErrorWithCode(e, 'step_up_required')) throw e;
    await stepUp();
    return fn();
  }
}
