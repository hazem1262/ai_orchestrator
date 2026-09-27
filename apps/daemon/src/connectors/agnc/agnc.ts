import type { AgncEvent, AgncMessage, AgncSession } from '@orc/api-contract';

export interface AgncConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
  beginAuth(): Promise<{ authorizationUrl: string | null }>;
  finishAuth(code: string, state: string): Promise<void>;
  listMySessions(): Promise<AgncSession[]>;
  getSession(id: string): Promise<AgncSession | null>;
  listMessages(id: string): Promise<AgncMessage[]>;
  listEvents(id: string, cursor?: string): Promise<{ items: AgncEvent[]; nextCursor: string | null }>;
  sendPrompt(id: string, prompt: string, model?: string): Promise<void>;
  createSession(i: {
    repoOwner: string;
    repoName: string;
    baseBranch?: string;
    title?: string;
    initialPrompt: string;
    model?: string;
  }): Promise<AgncSession>;
  disconnect(): Promise<void>;
}
