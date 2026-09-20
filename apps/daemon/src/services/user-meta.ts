import type { SavedView } from '@orc/api-contract';
import type { OrcDb } from '../db/client.ts';
import * as repo from '../db/repos/user-meta.ts';
import { ServiceError } from './errors.ts';

export interface UserMetaService {
  setPinned(pk: string, pinned: boolean): boolean;
  setLabels(pk: string, labels: string[]): string[];
  labels(): string[];
  views(): SavedView[];
  saveView(i: { name: string; query: Record<string, string> }): SavedView;
  deleteView(id: string): boolean;
}

export function createUserMetaService(db: OrcDb): UserMetaService {
  const mustExist = (pk: string): void => {
    if (!repo.sessionExists(db, pk)) throw new ServiceError('not_found', 404, `session ${pk} not found`);
  };
  return {
    setPinned(pk, pinned) {
      mustExist(pk);
      repo.setPinned(db, pk, pinned);
      return pinned;
    },
    setLabels(pk, labels) {
      mustExist(pk);
      return repo.setLabels(db, pk, labels);
    },
    labels: () => repo.allLabels(db),
    views: () => repo.listViews(db),
    saveView: (i) => repo.insertView(db, i),
    deleteView: (id) => repo.deleteView(db, id),
  };
}
