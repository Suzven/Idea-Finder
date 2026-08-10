import { describe, expect, it } from "vitest";
import {
  flattenRedditComments,
  normalizeRedditPost,
  normalizeRedditWebComment,
  normalizeRedditWebPost,
} from "../server/services/redditOverview";

function comment(id: string, body: string, replies: unknown[] = []) {
  return {
    kind: "t1",
    data: {
      id,
      author: `author_${id}`,
      body,
      created_utc: 1_700_000_000,
      permalink: `/r/research/comments/post/${id}/`,
      parent_id: "t3_post",
      score: 7,
      replies: replies.length ? { data: { children: replies } } : "",
    },
  };
}

describe("Reddit public data parser", () => {
  it("normalizes a Reddit post without depending on CSS classes", () => {
    expect(normalizeRedditPost({
      kind: "t3",
      data: {
        id: "abc123",
        title: "What do customers dislike?",
        selftext: "A detailed discussion",
        author: "product_researcher",
        subreddit: "startups",
        created_utc: 1_700_000_000,
        permalink: "/r/startups/comments/abc123/example/",
        url: "https://example.com/landing",
        score: 125,
        num_comments: 48,
      },
    })).toMatchObject({
      id: "abc123",
      title: "What do customers dislike?",
      author: "product_researcher",
      subreddit: "r/startups",
      permalink: "https://www.reddit.com/r/startups/comments/abc123/example/",
      destinationUrl: "https://example.com/landing",
      score: 125,
      commentCount: 48,
    });
  });

  it("keeps the Reddit comment tree depth in the flattened report", () => {
    const tree = [comment("root", "Root", [comment("child", "Child", [comment("grandchild", "Grandchild")])])];
    const result = flattenRedditComments(tree, 2);
    expect(result.comments.map(({ id, depth }) => ({ id, depth }))).toEqual([
      { id: "root", depth: 0 },
      { id: "child", depth: 1 },
      { id: "grandchild", depth: 2 },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("marks hidden replies when the selected depth cuts a branch", () => {
    const tree = [comment("root", "Root", [comment("child", "Child", [comment("grandchild", "Grandchild")])])];
    const result = flattenRedditComments(tree, 1);
    expect(result.comments.map((item) => item.id)).toEqual(["root", "child"]);
    expect(result.truncated).toBe(true);
  });

  it("marks Reddit more-comments placeholders as truncated", () => {
    const result = flattenRedditComments([{ kind: "more", data: { children: ["one", "two"] } }], 4);
    expect(result.comments).toEqual([]);
    expect(result.truncated).toBe(true);
  });

  it("normalizes a post extracted from Chromium markup", () => {
    expect(normalizeRedditWebPost({
      id: "t3_web123",
      title: "Cleaning services research",
      text: "What matters when choosing a company?",
      author: "market_researcher",
      subreddit: "cleaningbusiness",
      timestamp: "2026-08-10T08:30:00.000Z",
      permalink: "/r/cleaningbusiness/comments/web123/cleaning_services_research/",
      score: 43,
      commentCount: 17,
    })).toMatchObject({
      id: "web123",
      author: "market_researcher",
      subreddit: "r/cleaningbusiness",
      score: 43,
      commentCount: 17,
    });
  });

  it("normalizes a nested comment extracted from Chromium markup", () => {
    expect(normalizeRedditWebComment({
      id: "t1_comment123",
      author: "customer_voice",
      text: "Price transparency matters most.",
      timestamp: "2026-08-10T09:00:00.000Z",
      permalink: "/r/research/comments/web123/post/comment123/",
      parentId: "t1_parent123",
      score: 12,
      depth: 3,
    })).toMatchObject({
      id: "comment123",
      parentId: "parent123",
      score: 12,
      depth: 3,
    });
  });
});
