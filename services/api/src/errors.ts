export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class VersionConflictError extends Error {
  constructor(
    readonly currentVersion: number,
    readonly expectedVersion: number,
  ) {
    super(`Dashboard is at version ${currentVersion}, not ${expectedVersion}.`);
  }
}
