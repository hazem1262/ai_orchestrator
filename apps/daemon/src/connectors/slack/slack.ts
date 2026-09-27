export interface SlackConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
}
