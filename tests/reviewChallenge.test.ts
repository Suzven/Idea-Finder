import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { cancelReviewChallenge, captureReviewChallengeFrame, clickReviewChallenge, registerReviewChallenge, scrollReviewChallenge } from "../server/services/reviewChallenge";

function createPageMock() {
  const click = vi.fn().mockResolvedValue(undefined);
  const wheel = vi.fn().mockResolvedValue(undefined);
  const screenshot = vi.fn().mockResolvedValue(Buffer.from("frame"));
  const page = {
    viewportSize: () => ({ width: 1_440, height: 1_000 }),
    isClosed: () => false,
    url: () => "https://www.capterra.com/cloudflare-check",
    screenshot,
    mouse: { click, wheel },
  } as unknown as Page;
  return { page, click, wheel, screenshot };
}

describe("manual review challenge", () => {
  it("returns the live frame only to the owning browser client", async () => {
    const mock = createPageMock();
    const handle = registerReviewChallenge("client-a", mock.page);

    await expect(captureReviewChallengeFrame(handle.challenge.id, "client-a")).resolves.toEqual(Buffer.from("frame"));
    await expect(captureReviewChallengeFrame(handle.challenge.id, "client-b")).rejects.toMatchObject({ code: "REVIEW_CHALLENGE_NOT_FOUND" });

    handle.close();
  });

  it("clamps remote pointer input to the Chromium viewport", async () => {
    const mock = createPageMock();
    const handle = registerReviewChallenge("client-click", mock.page);

    await clickReviewChallenge(handle.challenge.id, "client-click", 9_999, -20);
    await scrollReviewChallenge(handle.challenge.id, "client-click", 9_999);

    expect(mock.click).toHaveBeenCalledWith(1_439, 0);
    expect(mock.wheel).toHaveBeenCalledWith(0, 1_500);
    cancelReviewChallenge(handle.challenge.id, "client-click");
    expect(handle.isCancelled()).toBe(true);
  });
});
