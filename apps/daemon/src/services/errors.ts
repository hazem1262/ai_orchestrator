export type ServiceErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 500;

/** Typed error for service/route layers: a stable `code`, an HTTP `status`, and optional `details`. */
export class ServiceError extends Error {
  readonly code: string;
  readonly status: ServiceErrorStatus;
  readonly details?: unknown;

  constructor(code: string, status: ServiceErrorStatus, message: string, details?: unknown) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
