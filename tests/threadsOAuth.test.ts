import { afterEach, describe, expect, it, vi } from "vitest";
import { assertThreadsTokenPermissions, consumeThreadsOAuthState, createThreadsAuthorization, inspectThreadsToken, requiredThreadsScopes } from "../server/services/threadsOAuth";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Threads OAuth", () => {
  it("requests every permission needed by the Threads overview", () => {
    const redirectUri = "https://ideafinder.mvppanel.store/api/threads/oauth/callback";
    const authorization = createThreadsAuthorization("user-1", "888868750548875", redirectUri);
    const url = new URL(authorization.authorizationUrl);

    expect(`${url.origin}${url.pathname}`).toBe("https://threads.net/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("888868750548875");
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(requiredThreadsScopes);
    expect(requiredThreadsScopes).toEqual([
      "threads_basic",
      "threads_keyword_search",
      "threads_read_replies",
    ]);

    expect(consumeThreadsOAuthState(authorization.state, "user-1")).toMatchObject({
      userId: "user-1",
      redirectUri,
    });
  });

  it("does not allow one user to finish another user's OAuth session", () => {
    const authorization = createThreadsAuthorization(
      "user-1",
      "888868750548875",
      "https://ideafinder.mvppanel.store/api/threads/oauth/callback",
    );

    expect(() => consumeThreadsOAuthState(authorization.state, "user-2")).toThrow(/недействительна/i);
  });

  it("confirms the scopes Meta actually granted to the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        app_id: "888868750548875",
        is_valid: true,
        scopes: requiredThreadsScopes,
        expires_at: 1_800_000_000,
      },
    }), { status: 200 })));

    await expect(inspectThreadsToken("valid-token-for-test", true)).resolves.toMatchObject({
      valid: true,
      missingScopes: [],
      scopes: requiredThreadsScopes,
    });
  });

  it("rejects a token when Meta silently omitted keyword search", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: {
        is_valid: true,
        scopes: ["threads_basic", "threads_read_replies"],
      },
    }), { status: 200 })));

    await expect(assertThreadsTokenPermissions("token-without-keyword-search", true)).rejects.toThrow(/threads_keyword_search/i);
  });
});
