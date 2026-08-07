import { describe, expect, it } from "vitest";
import { decodeThreadsWebCursor, normalizeThreadsWebPost, parseThreadsViewCount } from "../server/services/threadsOverview";

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
      viewCount: "1 283 955 просмотров",
    })).toEqual({
      id: "Dbu3coEiUry",
      username: "product_person",
      text: "What is the hardest part of onboarding?",
      timestamp: "2026-08-07T09:30:00.000Z",
      permalink: "https://www.threads.com/@product_person/post/Dbu3coEiUry",
      mediaType: "IMAGE",
      mediaUrl: "https://cdn.example.com/post.jpg",
      topicTag: "productmanagement",
      viewCount: 1_283_955,
    });
  });

  it("parses localized Threads view counters", () => {
    expect(parseThreadsViewCount("Ветка\n1 283 955 просмотров\n@user")).toBe(1_283_955);
    expect(parseThreadsViewCount("Thread\n1,2 млн просмотров")).toBe(1_200_000);
    expect(parseThreadsViewCount("Thread\n4.5K views")).toBe(4_500);
    expect(parseThreadsViewCount("Текст поста без счётчика")).toBeUndefined();
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
