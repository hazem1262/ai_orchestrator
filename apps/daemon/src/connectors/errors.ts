import { ServiceError } from '../services/errors.ts';

export type ConnectorErrorCode = 'unauthenticated' | 'not_found' | 'bad_request' | 'upstream_error';

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
  }
}

const STATUS = { unauthenticated: 401, not_found: 404, bad_request: 400, upstream_error: 502 } as const;

export function toServiceError(e: unknown): unknown {
  return e instanceof ConnectorError ? new ServiceError(e.code, STATUS[e.code], e.message) : e;
}
