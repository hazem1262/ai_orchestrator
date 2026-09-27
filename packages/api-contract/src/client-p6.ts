import type { InboxItem, Source } from '@orc/core';
import type { z } from 'zod';
import type { Caller } from './client-p2.ts';
import type {
  ConnectorId,
  ConnectorStatus,
  LinearFollowUpBody,
  LinearIssue,
  ShareSource,
  SlackPostBody,
} from './routes/connectors.ts';
import type {
  AwayMode,
  AwayState,
  PairingCode,
  PairResult,
  PushSubscriptionBody,
  RemoteConfigBody,
  RemoteDevice,
  RemoteStatus,
  StepUpResult,
} from './routes/remote.ts';

const enc = encodeURIComponent;

export function p6Methods(call: Caller) {
  return {
    connectorsList: () => call<ConnectorStatus[]>('GET', '/api/connectors'),
    connectorsSetToken: (id: ConnectorId, token: string) =>
      call<ConnectorStatus>('POST', `/api/connectors/${id}/token`, { token }),
    connectorsSetApp: (id: ConnectorId, clientId: string, clientSecret: string) =>
      call<{ ok: true }>('POST', `/api/connectors/${id}/app`, { clientId, clientSecret }),
    connectorsAuthorize: (id: ConnectorId) => call<{ url: string }>('GET', `/api/connectors/${id}/authorize`),
    connectorsDisconnect: (id: ConnectorId, confirm: boolean) =>
      call<{ ok: true }>('DELETE', `/api/connectors/${id}`, { confirm }),
    linearIssue: (identifier: string) => call<LinearIssue>('GET', `/api/linear/issues/${enc(identifier)}`),
    linearComment: (identifier: string, source: ShareSource, confirm: boolean) =>
      call<{ ok: true }>('POST', `/api/linear/issues/${enc(identifier)}/comment`, { source, confirm }),
    linearFollowUp: (body: z.input<typeof LinearFollowUpBody>) =>
      call<LinearIssue>('POST', '/api/linear/follow-up', body),
    slackPost: (body: z.input<typeof SlackPostBody>) => call<{ ts: string }>('POST', '/api/slack/post', body),
    sessionsReply: (source: Source, id: string, text: string) =>
      call<{ ok: true }>('POST', `/api/sessions/${source}/${enc(id)}/reply`, { text }),
    inboxApprove: (id: string) => call<InboxItem>('POST', `/api/inbox/${enc(id)}/approve`, { confirm: true }),
    remoteStatus: () => call<RemoteStatus>('GET', '/api/remote/status'),
    remoteSetConfig: (body: RemoteConfigBody) => call<RemoteStatus>('POST', '/api/remote/config', body),
    remoteCreatePairing: () => call<PairingCode>('POST', '/api/remote/pairing', {}),
    remotePair: (code: string, name: string) => call<PairResult>('POST', '/api/remote/pair', { code, name }),
    remoteDevices: () => call<RemoteDevice[]>('GET', '/api/remote/devices'),
    remoteRevokeDevice: (id: string) =>
      call<{ ok: true }>('DELETE', `/api/remote/devices/${enc(id)}`, { confirm: true }),
    awayGet: () => call<AwayState>('GET', '/api/remote/away'),
    awaySet: (mode: AwayMode) => call<AwayState>('POST', '/api/remote/away', { mode }),
    webauthnRegisterOptions: <T = Record<string, unknown>>() =>
      call<T>('POST', '/api/webauthn/register/options', {}),
    webauthnRegisterVerify: (response: unknown) =>
      call<{ credentialId: string }>('POST', '/api/webauthn/register/verify', { response }),
    webauthnStepUpOptions: <T = Record<string, unknown>>() =>
      call<T>('POST', '/api/webauthn/stepup/options', {}),
    webauthnStepUpVerify: (response: unknown) =>
      call<StepUpResult>('POST', '/api/webauthn/stepup/verify', { response }),
    pushPublicKey: () => call<{ publicKey: string }>('GET', '/api/push/vapid-public-key'),
    pushSubscribe: (sub: PushSubscriptionBody) => call<{ ok: true }>('POST', '/api/push/subscriptions', sub),
    pushUnsubscribe: (endpoint: string) =>
      call<{ ok: true }>('DELETE', '/api/push/subscriptions', { endpoint }),
    pushTest: () => call<{ sent: number }>('POST', '/api/push/test', {}),
  };
}

export type P6Methods = ReturnType<typeof p6Methods>;

export function isApiErrorWithCode(
  e: unknown,
  code: string,
): e is { status: number; code: string; message: string; details?: unknown } {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === code;
}
