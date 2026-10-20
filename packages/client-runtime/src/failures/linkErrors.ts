const TRANSPORT_ERROR_PATTERNS = [
  /\bSocket is not connected\b/i,
  /\bSocketOpenError\b/i,
  /\bSocketCloseError\b/i,
  /Unable to connect to the Kora server WebSocket\./i,
  /\bcould not establish a WebSocket connection\.$/i,
  /\bdisconnected\.$/i,
  /\bis not connected\.$/i,
  /\bping timeout\b/i,
  /\bRpcClientError\b/i,
  /\bClientProtocolError\b/i,
] as const;

/**
 * Check whether an error message originates from a transport-level connection
 * failure (socket close, socket open, ping timeout, etc.) rather than a
 * business-logic error.
 */
export function isTransportLinkErrorMessage(message: string | null | undefined): boolean {
  const text = typeof message === "string" ? message.trim() : "";
  return text !== "" && TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Strip transport connection errors from user-facing error messages.
 * Returns `null` for transport errors so the UI can distinguish between
 * real errors and transient connection issues.
 */
type MaybeMessage = string | null | undefined;

export const sanitizeThreadErrorMessage = (message: MaybeMessage): string | null =>
  isTransportLinkErrorMessage(message) ? null : (message ?? null);
