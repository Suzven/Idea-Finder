import { AppError } from "../errors.js";
import type {
  ThreadsConversationResponse,
  ThreadsPost,
  ThreadsReply,
  ThreadsSearchRequest,
  ThreadsSearchResponse,
} from "../../src/shared/types.js";

const THREADS_API_BASE = "https://graph.threads.net";
const SEARCH_FIELDS = [
  "id", "media_type", "media_url", "permalink", "username", "text", "timestamp",
  "thumbnail_url", "has_replies", "topic_tag", "is_verified", "profile_picture_url",
  "link_attachment_url",
].join(",");
const CONVERSATION_FIELDS = [
  "id", "text", "timestamp", "media_type", "media_url", "permalink", "username",
  "profile_picture_url", "has_replies", "is_reply", "replied_to", "thumbnail_url", "is_verified",
].join(",");
const MAX_CONVERSATION_PAGES = 10;
const MAX_REPLIES = 500;

interface ThreadsApiErrorPayload {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

interface ThreadsApiPage {
  data?: unknown[];
  paging?: {
    cursors?: { after?: string };
    next?: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeThreadsPost(value: unknown): ThreadsPost | null {
  const item = asRecord(value);
  const id = optionalString(item.id);
  if (!id) return null;
  return {
    id,
    username: optionalString(item.username) ?? "threads_user",
    text: optionalString(item.text) ?? "",
    timestamp: optionalString(item.timestamp) ?? "",
    permalink: optionalString(item.permalink) ?? `https://www.threads.net/post/${encodeURIComponent(id)}`,
    ...(optionalString(item.media_type) ? { mediaType: optionalString(item.media_type) } : {}),
    ...(optionalString(item.media_url) ? { mediaUrl: optionalString(item.media_url) } : {}),
    ...(optionalString(item.thumbnail_url) ? { thumbnailUrl: optionalString(item.thumbnail_url) } : {}),
    ...(optionalString(item.profile_picture_url) ? { profilePictureUrl: optionalString(item.profile_picture_url) } : {}),
    ...(typeof item.is_verified === "boolean" ? { isVerified: item.is_verified } : {}),
    ...(typeof item.has_replies === "boolean" ? { hasReplies: item.has_replies } : {}),
    ...(optionalString(item.topic_tag) ? { topicTag: optionalString(item.topic_tag) } : {}),
    ...(optionalString(item.link_attachment_url) ? { linkAttachmentUrl: optionalString(item.link_attachment_url) } : {}),
  };
}

export function normalizeThreadsReply(value: unknown): ThreadsReply | null {
  const post = normalizeThreadsPost(value);
  if (!post) return null;
  const item = asRecord(value);
  const repliedTo = asRecord(item.replied_to);
  const parentId = optionalString(repliedTo.id);
  return { ...post, ...(parentId ? { parentId } : {}), depth: 0 };
}

function withReplyDepth(replies: ThreadsReply[], rootId: string): ThreadsReply[] {
  const byId = new Map(replies.map((reply) => [reply.id, reply]));
  const depthOf = (reply: ThreadsReply): number => {
    let depth = 0;
    let parentId = reply.parentId;
    const visited = new Set<string>([reply.id]);
    while (parentId && parentId !== rootId && byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)?.parentId;
    }
    return Math.min(depth, 6);
  };
  return replies.map((reply) => ({ ...reply, depth: depthOf(reply) }));
}

function threadsApiError(status: number, payload: ThreadsApiErrorPayload, fallback: string): AppError {
  const meta = payload.error;
  const message = meta?.message || fallback;
  const details = {
    httpStatus: status,
    metaCode: meta?.code,
    metaSubcode: meta?.error_subcode,
    metaType: meta?.type,
    fbtraceId: meta?.fbtrace_id,
  };
  if (meta?.code === 190) {
    return new AppError(401, "THREADS_TOKEN_INVALID", "Threads Access Token недействителен или истёк.", "Откройте настройки Threads и сохраните новый токен.", details);
  }
  if (status === 429 || meta?.code === 4 || meta?.code === 17 || meta?.code === 32) {
    return new AppError(429, "THREADS_RATE_LIMIT", "Threads временно ограничил количество запросов.", "Подождите несколько минут и повторите запрос.", details);
  }
  if (status === 403 || meta?.code === 10 || meta?.code === 200) {
    return new AppError(403, "THREADS_PERMISSION_MISSING", message, "Проверьте права threads_basic, threads_keyword_search и threads_read_replies у токена.", details);
  }
  return new AppError(502, "THREADS_API_ERROR", message, "Повторите запрос. Если ошибка сохранится, замените Threads Access Token.", details);
}

async function fetchThreadsPage(url: URL, token: string): Promise<ThreadsApiPage> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new AppError(504, "THREADS_NETWORK_ERROR", "Сервер не дождался ответа Threads API.", "Повторите запрос через несколько секунд.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const raw = await response.text();
  let payload: ThreadsApiPage & ThreadsApiErrorPayload;
  try {
    payload = JSON.parse(raw) as ThreadsApiPage & ThreadsApiErrorPayload;
  } catch {
    throw new AppError(502, "THREADS_INVALID_RESPONSE", "Threads API вернул ответ в неожиданном формате.", undefined, {
      httpStatus: response.status,
      responsePreview: raw.replace(/\s+/g, " ").slice(0, 500),
    });
  }
  if (!response.ok || payload.error) throw threadsApiError(response.status, payload, `Threads API вернул HTTP ${response.status}.`);
  return payload;
}

function unixSeconds(iso?: string): string | undefined {
  if (!iso) return undefined;
  const milliseconds = Date.parse(iso);
  return Number.isFinite(milliseconds) ? String(Math.floor(milliseconds / 1000)) : undefined;
}

export async function searchThreadsPosts(request: ThreadsSearchRequest, token: string): Promise<ThreadsSearchResponse> {
  const url = new URL(`${THREADS_API_BASE}/keyword_search`);
  url.searchParams.set("q", request.query);
  url.searchParams.set("search_type", request.searchType);
  url.searchParams.set("search_mode", request.searchMode);
  url.searchParams.set("limit", String(request.limit));
  url.searchParams.set("fields", SEARCH_FIELDS);
  const since = unixSeconds(request.since);
  const until = unixSeconds(request.until);
  if (since) url.searchParams.set("since", since);
  if (until) url.searchParams.set("until", until);
  if (request.after) url.searchParams.set("after", request.after);
  const payload = await fetchThreadsPage(url, token);
  const posts = (payload.data ?? []).map(normalizeThreadsPost).filter((post): post is ThreadsPost => Boolean(post));
  return {
    query: request.query,
    posts,
    ...(payload.paging?.cursors?.after && payload.paging.next ? { nextCursor: payload.paging.cursors.after } : {}),
    warnings: posts.length ? [] : ["Threads не нашёл публичных постов по этому запросу."],
  };
}

export async function fetchThreadsConversation(post: ThreadsPost, token: string): Promise<ThreadsConversationResponse> {
  const replies: ThreadsReply[] = [];
  let nextUrl: URL | undefined = new URL(`${THREADS_API_BASE}/${encodeURIComponent(post.id)}/conversation`);
  nextUrl.searchParams.set("fields", CONVERSATION_FIELDS);
  nextUrl.searchParams.set("limit", "50");
  let pages = 0;
  while (nextUrl && pages < MAX_CONVERSATION_PAGES && replies.length < MAX_REPLIES) {
    const payload = await fetchThreadsPage(nextUrl, token);
    for (const rawItem of payload.data ?? []) {
      const reply = normalizeThreadsReply(rawItem);
      if (reply && reply.id !== post.id && !replies.some((current) => current.id === reply.id)) replies.push(reply);
      if (replies.length >= MAX_REPLIES) break;
    }
    pages += 1;
    nextUrl = payload.paging?.next ? new URL(payload.paging.next) : undefined;
  }
  const truncated = Boolean(nextUrl) || replies.length >= MAX_REPLIES;
  return {
    post,
    replies: withReplyDepth(replies, post.id),
    warnings: truncated ? [`Для PDF загружены первые ${replies.length} ответов. Очень длинная ветка была ограничена.`] : [],
    truncated,
  };
}
