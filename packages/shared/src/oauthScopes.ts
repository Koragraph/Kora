import * as Schema from "effect/Schema";

// Printable ASCII except space, double quote and backslash (RFC 6749 scope-token).
const OAUTH_SCOPE_TOKEN = /^[\u0021\u0023-\u005b\u005d-\u007e]+$/u;

const scopeList = Schema.Array(Schema.String);

export class OAuthScopeEncodingError extends Schema.TaggedError<OAuthScopeEncodingError>()(
  "OAuthScopeEncodingError",
  { duplicateScopes: scopeList, invalidScopes: scopeList, scopes: scopeList },
) {
  override get message(): string {
    return "OAuth scopes must be non-empty, syntactically valid, and unique.";
  }
}

function findRepeats(scopes: ReadonlyArray<string>): string[] {
  const counts = new Map<string, number>();
  for (const scope of scopes) counts.set(scope, (counts.get(scope) ?? 0) + 1);
  return [...counts].filter(([, n]) => n > 1).map(([scope]) => scope);
}

export function encodeOAuthScope(scopes: ReadonlyArray<string>): string {
  const invalidScopes = scopes.filter((scope) => !OAUTH_SCOPE_TOKEN.test(scope));
  const duplicateScopes = findRepeats(scopes);
  const acceptable = scopes.length > 0 && !invalidScopes.length && !duplicateScopes.length;
  if (!acceptable) throw new OAuthScopeEncodingError({ scopes, invalidScopes, duplicateScopes });
  return scopes.join(" ");
}
