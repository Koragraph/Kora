import { describe, expect, it } from "vite-plus/test";

import { encodeOAuthScope, OAuthScopeEncodingError } from "./oauthScopes.ts";

describe("OAuth scope encoding", () => {
  it("throws a typed error listing the invalid and repeated scopes", () => {
    const scopes = ["repo:write", "has space", "repo:write"];
    let failure: unknown;
    try {
      encodeOAuthScope(scopes);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OAuthScopeEncodingError);
    expect(failure).toMatchObject({
      scopes,
      invalidScopes: ["has space"],
      duplicateScopes: ["repo:write"],
      message: "OAuth scopes must be non-empty, syntactically valid, and unique.",
    });
  });
});
