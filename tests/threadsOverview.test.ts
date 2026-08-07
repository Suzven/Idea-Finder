import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeThreadsPost, normalizeThreadsReply, searchThreadsPosts } from "../server/services/threadsOverview";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("retries an empty TOP search as RECENT and keeps the returned cursor", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "recent-1", username: "player", text: "New games this week" }],
        paging: { cursors: { after: "cursor-without-next-url" } },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchThreadsPosts({
      query: "games",
      searchType: "TOP",
      searchMode: "KEYWORD",
      limit: 25,
      since: "2026-08-01T00:00:00.000Z",
    }, "secret-token");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("search_type=RECENT");
    expect(result.posts).toHaveLength(1);
    expect(result.nextCursor).toBe("cursor-without-next-url");
    expect(result.appliedFilters).toMatchObject({ searchType: "RECENT", fallback: true });
    expect(result.warnings[0]).toMatch(/сначала свежие/i);
  });

  it("reports every fallback attempt when Meta accepts the search but returns no data", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchThreadsPosts({
      query: "missing phrase",
      searchType: "TOP",
      searchMode: "KEYWORD",
      limit: 10,
      since: "2026-08-01T00:00:00.000Z",
    }, "secret-token");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.posts).toEqual([]);
    expect(result.warnings[0]).toContain("4 вариантов поиска");
  });
});
