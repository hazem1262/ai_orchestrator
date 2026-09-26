import { ApiRequestError } from '@orc/api-contract';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

export interface ConfirmRequest<V> {
  summary: string;
  details: Record<string, unknown>;
  vars: V;
}

export interface ConfirmedMutationOptions<V, R> {
  onSuccess?: (r: R, vars: V) => void;
  invalidate?: ReadonlyArray<readonly unknown[]>;
}

/**
 * Runs a guarded git action. The first call goes out with `confirm: false`; a 409
 * `confirmation_required` becomes `pending` (the daemon's summary and details), and `confirm()`
 * retries with `confirm: true`, optionally patching the vars (e.g. `confirmExternal`).
 */
export function useConfirmedMutation<V, R>(
  fn: (vars: V, confirm: boolean) => Promise<R>,
  opts: ConfirmedMutationOptions<V, R> = {},
) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<ConfirmRequest<V> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | Error | null>(null);
  const [data, setData] = useState<R | null>(null);
  // Callers pass inline closures; a ref keeps `exec` stable without stale callbacks.
  const latest = useRef({ fn, opts });
  latest.current = { fn, opts };

  const exec = useCallback(
    async (vars: V, confirm: boolean) => {
      const { fn: call, opts: o } = latest.current;
      setBusy(true);
      setError(null);
      try {
        const r = await call(vars, confirm);
        setData(r);
        setPending(null);
        for (const key of o.invalidate ?? []) await qc.invalidateQueries({ queryKey: [...key] });
        o.onSuccess?.(r, vars);
      } catch (err) {
        if (
          !confirm &&
          err instanceof ApiRequestError &&
          err.status === 409 &&
          err.code === 'confirmation_required'
        ) {
          const details = (err.details ?? {}) as Record<string, unknown>;
          setPending({ summary: String(details.summary ?? err.message), details, vars });
        } else {
          setPending(null);
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        setBusy(false);
      }
    },
    [qc],
  );

  return {
    pending,
    busy,
    error,
    data,
    run: (vars: V) => exec(vars, false),
    confirm: async (patch?: Partial<V>) => {
      if (!pending) return;
      const vars = patch ? ({ ...pending.vars, ...patch } as V) : pending.vars;
      await exec(vars, true);
    },
    cancel: () => setPending(null),
  };
}
