/**
 * User-facing message shown when an infrastructure dependency (currently
 * ValKey) is unavailable for a path that MUST fail closed (login, register,
 * 2FA challenge). Server actions RETURN this as a normal error result (HTTP
 * 200) so the user sees a clear inline message on the form instead of an
 * HTTP 500 error page.
 */
export const SERVICE_UNAVAILABLE_MESSAGE =
  "Service temporarily unavailable. Please try again shortly.";

/**
 * Error type kept for programmatic checks; the actions surface the message
 * above as a result rather than throwing this.
 */
export class ServiceUnavailableError extends Error {
  constructor(message = SERVICE_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}