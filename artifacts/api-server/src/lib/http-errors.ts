/**
 * Request-validation failures that must reach the caller as 400, not 500.
 *
 * Risk report S-13/S-16. Every lab parameter parser in routes/analyst/shared.ts
 * threw a bare Error, and the research routes hand that to `next(error)`. The
 * only error middleware in app.ts answers everything with 500 "Internal server
 * error". So a mistyped playerId, an unsupported window, or a malformed date
 * was reported to the operator as a server fault, with the actual reason only
 * in the API log. The triage guide's "search returns 400" step could not fire,
 * because the API had no path that produced a 400 for these routes.
 *
 * Other domains (bettor, models, settlement) already answer 400 by catching
 * their own typed validation error in each handler. This is the same contract,
 * declared once so the shared parsers get it without every handler repeating
 * the catch.
 */
export class RequestValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function isRequestValidationError(error: unknown): error is RequestValidationError {
  return error instanceof RequestValidationError;
}
