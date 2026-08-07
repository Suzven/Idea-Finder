import { describe, expect, it } from "vitest";
import { normalizeThreadsPost, normalizeThreadsReply } from "../server/services/threadsOverview";

describe("Threads API response parser", () => {
  it("normalizes a public keyword search result", () => {
    expect(normalizeThreadsPost({
      id: "123",
      username: "product_person",
      text: "What is the hardest part of onboarding?",
      timestamp: "2026-08-07T09:30:00+0000",
      permalink: "https://www.threads.net/@product_person/post/123",
      media_type: "IMAGE",
      media_url: "https://cdn.example.com/post.jpg",
      profile_picture_url: "https://cdn.example.com/avatar.jpg",
      has_replies: true,
      is_verified: true,
      topic_tag: "productmanagement",
    })).toEqual({
      id: "123",
      username: "product_person",
      text: "What is the hardest part of onboarding?",
      timestamp: "2026-08-07T09:30:00+0000",
      permalink: "https://www.threads.net/@product_person/post/123",
      mediaType: "IMAGE",
      mediaUrl: "https://cdn.example.com/post.jpg",
      profilePictureUrl: "https://cdn.example.com/avatar.jpg",
      hasReplies: true,
      isVerified: true,
      topicTag: "productmanagement",
    });
  });

  it("keeps the reply parent relationship", () => {
    expect(normalizeThreadsReply({
      id: "reply-2",
      username: "customer",
      text: "I struggle with the first empty screen.",
      timestamp: "2026-08-07T10:00:00+0000",
      permalink: "https://www.threads.net/post/reply-2",
      replied_to: { id: "reply-1" },
    })).toMatchObject({ id: "reply-2", parentId: "reply-1", depth: 0 });
  });

  it("ignores malformed items without an id", () => {
    expect(normalizeThreadsPost({ text: "missing id" })).toBeNull();
    expect(normalizeThreadsReply(null)).toBeNull();
  });
});
