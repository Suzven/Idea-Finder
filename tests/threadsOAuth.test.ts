import { describe, expect, it } from "vitest";
import { consumeThreadsOAuthState, createThreadsAuthorization, requiredThreadsScopes } from "../server/services/threadsOAuth";

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
});
