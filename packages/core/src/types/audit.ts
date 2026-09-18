export type AuditActor = 'user' | 'automation' | 'supervisor' | 'remote';
export interface AuditEntry {
  id: string;
  ts: string;
  actor: AuditActor;
  actorDetail: string | null;
  action: string;
  target: string | null;
  params: Record<string, unknown>;
  result: 'ok' | 'error' | 'denied';
  error: string | null;
}
