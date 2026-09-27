import type { Automation, AutomationRun } from '@orc/api-contract';

export type { Automation, AutomationRun, AutomationRunDetail } from '@orc/api-contract';

/** Contracts §11 (P7). The implementation adds more members: see AutomationServiceImpl in service.ts. */
export interface AutomationService {
  list(): Automation[];
  save(a: Automation): Automation;
  runNow(id: string): Promise<AutomationRun>;
  runs(id: string): AutomationRun[];
}
