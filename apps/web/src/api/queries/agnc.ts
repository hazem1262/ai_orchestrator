import type { AgncSession } from '@orc/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getApiClient } from '@/api/client.ts';
import { useConfirmedMutation } from '@/features/git/useConfirmedMutation.ts';

export const agncKeys = {
  status: ['agnc-status'] as const,
  messages: (id: string) => ['agnc-messages', id] as const,
  events: (id: string) => ['agnc-events', id] as const,
};

export interface AgncPromptVars {
  prompt: string;
  model?: string;
}

export interface AgncHandoffVars {
  source: 'claude' | 'codex';
  id: string;
  repoOwner?: string;
  repoName?: string;
}

export function useAgncStatus() {
  return useQuery({ queryKey: agncKeys.status, queryFn: () => getApiClient().agncStatus() });
}

export function useAgncConnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().agncConnect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: agncKeys.status }),
  });
}

/** The client sends `confirm: true`; callers ask the user first. */
export function useAgncDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => getApiClient().agncDisconnect(),
    onSuccess: () => qc.invalidateQueries({ queryKey: agncKeys.status }),
  });
}

export function useAgncMessages(id: string) {
  return useQuery({
    queryKey: agncKeys.messages(id),
    queryFn: () => getApiClient().agncMessages(id),
    refetchInterval: 15_000,
  });
}

export function useAgncEvents(id: string) {
  return useQuery({
    queryKey: agncKeys.events(id),
    queryFn: () => getApiClient().agncEvents(id),
    refetchInterval: 15_000,
  });
}

/**
 * Sends a prompt to an AGNC session. The first request goes out without `confirm`; the daemon's
 * `409 confirmation_required` becomes `pending`, and `confirm()` resends with `confirm: true`.
 */
export function useAgncPrompt(id: string, opts: { onSuccess?: () => void } = {}) {
  return useConfirmedMutation<AgncPromptVars, { ok: true }>(
    (vars, confirm) => getApiClient().agncPrompt(id, confirm ? { ...vars, confirm: true } : vars),
    { invalidate: [agncKeys.messages(id), agncKeys.events(id)], onSuccess: () => opts.onSuccess?.() },
  );
}

/** Creates an AGNC session from a local session's handoff, through the same 409 confirmation. */
export function useAgncHandoff() {
  return useConfirmedMutation<AgncHandoffVars, AgncSession>(
    (vars, confirm) => getApiClient().agncHandoff(confirm ? { ...vars, confirm: true } : vars),
    { invalidate: [agncKeys.status] },
  );
}
