import { describe, expect, it } from "vitest";
import { isSpyServiceAuthenticationFailure } from "../src/api";

describe("isSpyServiceAuthenticationFailure", () => {
  it("invalidates the workspace session only for its own auth error", () => {
    expect(isSpyServiceAuthenticationFailure(401, "AUTH_REQUIRED")).toBe(true);
  });

  it("keeps the workspace session for external service credentials", () => {
    expect(isSpyServiceAuthenticationFailure(401, "OPENAI_KEY_INVALID")).toBe(false);
    expect(isSpyServiceAuthenticationFailure(401, "META_TOKEN_INVALID")).toBe(false);
    expect(isSpyServiceAuthenticationFailure(422, "THREADS_LOGIN_FAILED")).toBe(false);
  });
});
