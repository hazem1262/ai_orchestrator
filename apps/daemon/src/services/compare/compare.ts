import type {
  ArchiveLosersResult,
  CompareEstimate,
  CompareGroup,
  CompareView,
  LaunchRequest,
} from '@orc/api-contract';

export interface CompareService {
  launch(req: LaunchRequest): Promise<CompareGroup>;
  estimate(projectId: string | null, n: number): CompareEstimate;
  get(id: string): CompareGroup | null;
  view(id: string): Promise<CompareView>;
  pickWinner(id: string, index: number): { group: CompareGroup; reviewUrl: string };
  archiveLosers(id: string): Promise<ArchiveLosersResult>;
}
