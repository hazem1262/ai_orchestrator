import type { ReviewComment } from '@orc/core';
import { useCallback, useEffect, useState } from 'react';

export interface ReviewDraft {
  comments: ReviewComment[];
  viewed: string[];
  add(c: ReviewComment): void;
  remove(index: number): void;
  clear(): void;
  clearComments(): void;
  toggleViewed(path: string): void;
}

interface Stored {
  comments: ReviewComment[];
  viewed: string[];
}

const storageKey = (key: string) => `orc.review.${key}`;

function load(key: string): Stored {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return { comments: [], viewed: [] };
    const parsed = JSON.parse(raw) as Partial<Stored>;
    return { comments: parsed.comments ?? [], viewed: parsed.viewed ?? [] };
  } catch {
    return { comments: [], viewed: [] };
  }
}

/** Review comments and viewed marks for one session, persisted in localStorage under `orc.review.<key>`. */
export function useReviewDraft(key: string): ReviewDraft {
  const [state, setState] = useState<Stored>(() => load(key));
  useEffect(() => setState(load(key)), [key]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(key), JSON.stringify(state));
    } catch {
      // storage can be unavailable (private mode); the draft still works in memory
    }
  }, [key, state]);

  const add = useCallback(
    (c: ReviewComment) => setState((s) => ({ ...s, comments: [...s.comments, c] })),
    [],
  );
  const remove = useCallback(
    (i: number) => setState((s) => ({ ...s, comments: s.comments.filter((_, j) => j !== i) })),
    [],
  );
  const clear = useCallback(() => setState({ comments: [], viewed: [] }), []);
  const clearComments = useCallback(() => setState((s) => ({ ...s, comments: [] })), []);
  const toggleViewed = useCallback(
    (path: string) =>
      setState((s) => ({
        ...s,
        viewed: s.viewed.includes(path) ? s.viewed.filter((p) => p !== path) : [...s.viewed, path],
      })),
    [],
  );
  return { comments: state.comments, viewed: state.viewed, add, remove, clear, clearComments, toggleViewed };
}
