export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

const str = (v: unknown, fallback: string) => (typeof v === 'string' && v !== '' ? v : fallback);

export function parsePushPayload(raw: string | null, fallbackUrl = '/inbox'): PushMessage {
  const base: PushMessage = {
    title: 'Orchestrator',
    body: 'Something needs you',
    url: fallbackUrl,
    tag: 'orchestrator',
  };
  if (!raw) return base;
  try {
    const v = JSON.parse(raw) as Partial<PushMessage> | null;
    if (typeof v !== 'object' || v === null) return { ...base, body: raw.slice(0, 180) };
    return {
      title: str(v.title, base.title),
      body: str(v.body, base.body),
      url: str(v.url, base.url),
      tag: str(v.tag, base.tag),
    };
  } catch {
    return { ...base, body: raw.slice(0, 180) };
  }
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
