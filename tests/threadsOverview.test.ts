import { describe, expect, it } from "vitest";
import { decodeThreadsWebCursor, normalizeThreadsWebPost } from "../server/services/threadsOverview";

describe("Threads public web parser", () => {
  it("normalizes a public card extracted by Chromium", () => {
    expect(normalizeThreadsWebPost({
      id: "Dbu3coEiUry",
      username: "product_person",
      text: "What is the hardest part of onboarding?",
      timestamp: "2026-08-07T09:30:00.000Z",
      permalink: "https://www.threads.com/@product_person/post/Dbu3coEiUry",
      mediaType: "IMAGE",
      mediaUrl: "https://cdn.example.com/post.jpg",
      profilePictureUrl: "https://cdn.example.com/broken-avatar.jpg",
      topicTag: "productmanagement",
    })).toEqual({
      id: "Dbu3coEiUry",
      username: "product_person",
      text: "What is the hardest part of onboarding?",
      timestamp: "2026-08-07T09:30:00.000Z",
      permalink: "https://www.threads.com/@product_person/post/Dbu3coEiUry",
      mediaType: "IMAGE",
      mediaUrl: "https://cdn.example.com/post.jpg",
      topicTag: "productmanagement",
    });
  });

  it("ignores malformed cards without a post id or permalink", () => {
    expect(normalizeThreadsWebPost({ text: "missing identity" })).toBeNull();
    expect(normalizeThreadsWebPost({ id: "post-1" })).toBeNull();
  });

  it("accepts only the local web pagination cursor format", () => {
    expect(decodeThreadsWebCursor()).toBe(0);
    expect(decodeThreadsWebCursor("web:25")).toBe(25);
    expect(decodeThreadsWebCursor("official-api-cursor")).toBe(0);
    expect(decodeThreadsWebCursor("web:-1")).toBe(0);
  });
});
