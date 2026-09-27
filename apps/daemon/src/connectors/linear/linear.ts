export interface LinearConnector {
  status(): Promise<'ok' | 'unauthenticated' | 'error'>;
}
