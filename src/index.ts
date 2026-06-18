#!/usr/bin/env node
/**
 * Standalone Instagram MCP Server
 *
 * Dual-purpose SENSE + ACT server for the Instagram Graph API.
 * Uses container-based publishing (create container → poll → publish).
 *
 * Tools:
 *   SENSE: ig_get_account_insights, ig_get_post_insights, ig_get_comments,
 *          ig_get_stories_insights, ig_get_audience_demographics, ig_get_hashtag_search
 *   ACT:   ig_publish_photo, ig_publish_carousel, ig_publish_reel,
 *          ig_reply_comment, ig_delete_comment
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { textResult, errorResult, senseResult } from "./response.js";
import {
  createClient,
  InstagramApiError,
  type InstagramClient,
} from "./client.js";
import { waitForRateLimit, withRetry, sleep } from "./rate-limiter.js";
import { sanitize } from "./sanitize.js";
import { extractApiDetail, suggestAction } from "./errors.js";
import {
  fetchAccountInsights,
  fetchPostInsights,
  fetchAudienceDemographics,
} from "./lib/insights.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

// --- Env-based defaults ---

const DEFAULT_ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const DEFAULT_ACCOUNT_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

// --- Credential resolution ---

const credentialFields = {
  accessToken: z
    .string()
    .optional()
    .describe(
      "Instagram access token. Falls back to INSTAGRAM_ACCESS_TOKEN env var.",
    ),
  accountId: z
    .string()
    .optional()
    .describe(
      "Instagram Business Account ID. Falls back to INSTAGRAM_BUSINESS_ACCOUNT_ID env var.",
    ),
};

interface CredentialArgs {
  accessToken?: string;
  accountId?: string;
}

export function resolveCredentials(
  args: CredentialArgs,
): { accessToken: string; accountId: string } | null {
  const accessToken = args.accessToken || DEFAULT_ACCESS_TOKEN;
  const accountId = args.accountId || DEFAULT_ACCOUNT_ID;
  if (!accessToken || !accountId) return null;
  return { accessToken, accountId };
}

type ClientResult =
  | { ok: true; client: InstagramClient }
  | { ok: false; error: ReturnType<typeof errorResult> };

export async function getClient(
  args: CredentialArgs,
  toolName?: string,
): Promise<ClientResult> {
  const creds = resolveCredentials(args);
  if (!creds) {
    return {
      ok: false,
      error: errorResult(
        "Missing credentials",
        "Provide accessToken + accountId as arguments, or set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID env vars.",
      ),
    };
  }

  // Pre-flight rate limit check (per-tenant, keyed by accountId)
  const limit = await waitForRateLimit(toolName, creds.accountId);
  if (!limit.allowed) {
    const retryAfterSeconds = Math.ceil(limit.retryAfterMs / 1000);
    return {
      ok: false,
      error: errorResult(
        "Rate limited",
        `Instagram API rate limit reached. Wait ${retryAfterSeconds}s then retry.`,
        {
          retryAfterSeconds,
          action:
            retryAfterSeconds <= 120
              ? `RETRY_AFTER_WAIT: Sleep ${retryAfterSeconds}s then retry this tool call.`
              : `DEFER: Rate limit cooldown is ${retryAfterSeconds}s. Switch to a different task.`,
        },
      ),
    };
  }

  try {
    const client = createClient(creds);
    return { ok: true, client };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return {
      ok: false,
      error: errorResult(
        "Client error",
        `Failed to create Instagram client: ${msg}`,
      ),
    };
  }
}

// --- Error handling ---

export function safeHandler<T>(
  toolName: string,
  handler: (
    args: T,
  ) => Promise<ReturnType<typeof textResult | typeof senseResult>>,
): (
  args: T,
) => Promise<
  ReturnType<typeof textResult | typeof senseResult | typeof errorResult>
> {
  return async (args: T) => {
    try {
      return await handler(args);
    } catch (e) {
      try {
        const msg = e instanceof Error ? e.message : String(e);
        const detail = extractApiDetail(e);
        const statusCode =
          e instanceof InstagramApiError ? e.status : undefined;
        const action = suggestAction(toolName, statusCode, detail, msg);
        console.error(
          `[${toolName}] Error: ${msg}${detail ? ` — ${detail}` : ""}`,
        );
        return errorResult(
          "API error",
          `${toolName} failed: ${detail || msg}`,
          {
            ...(statusCode !== undefined && { statusCode }),
            ...(detail && detail !== msg && { rawError: msg }),
            ...(action && { action }),
          },
        );
      } catch (formatErr) {
        const fallback = e instanceof Error ? e.message : "Unknown error";
        const fmtMsg =
          formatErr instanceof Error ? formatErr.message : String(formatErr);
        console.error(
          `[${toolName}] Error (fallback): ${fallback} — error formatting also failed: ${fmtMsg}`,
        );
        return errorResult("API error", `${toolName} failed: ${fallback}`);
      }
    }
  };
}

// --- Server Setup ---

const server = new McpServer({
  name: "instagram-mcp-server",
  version,
});

// =====================
// SENSE Tools (read)
// =====================

server.registerTool(
  "ig_get_account_insights",
  {
    description:
      "Get Instagram account insights: impressions, reach, follower growth, and profile views over a period.",
    inputSchema: {
      ...credentialFields,
      period: z
        .enum(["day", "week", "days_28"])
        .optional()
        .describe('Aggregation period (default: "day")'),
      since: z
        .string()
        .optional()
        .describe("Start date as Unix timestamp (e.g., '1700000000')"),
      until: z.string().optional().describe("End date as Unix timestamp"),
    },
  },
  safeHandler("ig_get_account_insights", async (args) => {
    const result = await getClient(args, "ig_get_account_insights");
    if (!result.ok) return result.error;
    const { client } = result;

    const data = await fetchAccountInsights(client, {
      period: args.period,
      since: args.since,
      until: args.until,
    });
    return senseResult(data, "Instagram");
  }),
);

server.registerTool(
  "ig_get_post_insights",
  {
    description:
      "Get engagement metrics for a specific Instagram post: impressions, reach, engagement, saves, shares.",
    inputSchema: {
      ...credentialFields,
      mediaId: z.string().describe("Instagram media ID"),
    },
  },
  safeHandler("ig_get_post_insights", async (args) => {
    if (!args.mediaId.trim())
      return errorResult("Invalid input", "mediaId cannot be empty");
    const result = await getClient(args, "ig_get_post_insights");
    if (!result.ok) return result.error;
    const { client } = result;

    const data = await fetchPostInsights(client, { mediaId: args.mediaId });
    return senseResult(data, "Instagram");
  }),
);

server.registerTool(
  "ig_get_comments",
  {
    description:
      "Get comments on an Instagram post. Returns comment text, username, and timestamp.",
    inputSchema: {
      ...credentialFields,
      mediaId: z.string().describe("Instagram media ID"),
      limit: z
        .number()
        .optional()
        .describe("Number of comments (default: 25, max: 50)"),
      after: z.string().optional().describe("Pagination cursor"),
    },
  },
  safeHandler("ig_get_comments", async (args) => {
    if (!args.mediaId.trim())
      return errorResult("Invalid input", "mediaId cannot be empty");
    const result = await getClient(args, "ig_get_comments");
    if (!result.ok) return result.error;
    const { client } = result;

    const params: Record<string, string> = {
      fields:
        "id,text,username,timestamp,like_count,replies{id,text,username,timestamp}",
      limit: String(Math.min(args.limit || 25, 50)),
    };
    if (args.after) params.after = args.after;

    const response = await withRetry(() =>
      client.get<{
        data: Array<{
          id: string;
          text: string;
          username: string;
          timestamp: string;
          like_count?: number;
          replies?: {
            data: Array<{
              id: string;
              text: string;
              username: string;
              timestamp: string;
            }>;
          };
        }>;
        paging?: { cursors?: { after?: string } };
      }>(`/${args.mediaId}/comments`, params),
    );

    // Sanitize user-generated content
    const comments = (response.data || []).map((c) => ({
      id: c.id,
      text: sanitize(c.text),
      username: sanitize(c.username),
      timestamp: c.timestamp,
      likeCount: c.like_count ?? 0,
      replies: c.replies?.data?.map((r) => ({
        id: r.id,
        text: sanitize(r.text),
        username: sanitize(r.username),
        timestamp: r.timestamp,
      })),
    }));

    return senseResult(
      {
        mediaId: args.mediaId,
        comments,
        count: comments.length,
        nextCursor: response.paging?.cursors?.after,
      },
      "Instagram",
    );
  }),
);

server.registerTool(
  "ig_get_stories_insights",
  {
    description:
      "Get insights for an active Instagram story: reach, replies, follows, profile_visits, total_interactions. Stories expire after 24 hours — storyId must reference a currently active story (fetch from /{ig-account-id}/stories).",
    inputSchema: {
      ...credentialFields,
      storyId: z.string().describe("Instagram story media ID"),
    },
  },
  safeHandler("ig_get_stories_insights", async (args) => {
    if (!args.storyId.trim())
      return errorResult("Invalid input", "storyId cannot be empty");
    const result = await getClient(args, "ig_get_stories_insights");
    if (!result.ok) return result.error;
    const { client } = result;

    const response = await withRetry(() =>
      client.get<{ data: unknown[] }>(`/${args.storyId}/insights`, {
        metric: "reach,replies,total_interactions",
      }),
    );

    return senseResult(
      { storyId: args.storyId, insights: response.data },
      "Instagram",
    );
  }),
);

server.registerTool(
  "ig_get_audience_demographics",
  {
    description:
      "Get follower demographics: city, country, and age/gender breakdown. Requires 100+ followers.",
    inputSchema: {
      ...credentialFields,
      metric: z
        .enum([
          "follower_demographics",
          "engaged_audience_demographics",
          "reached_audience_demographics",
        ])
        .optional()
        .describe(
          "Demographic metric (default: follower_demographics). Requires 100+ followers.",
        ),
      breakdown: z
        .enum(["age", "city", "country", "gender"])
        .optional()
        .describe("Breakdown dimension (default: country)"),
    },
  },
  safeHandler("ig_get_audience_demographics", async (args) => {
    const result = await getClient(args, "ig_get_audience_demographics");
    if (!result.ok) return result.error;
    const { client } = result;

    const data = await fetchAudienceDemographics(client, {
      metric: args.metric,
      breakdown: args.breakdown,
    });
    return senseResult(data, "Instagram");
  }),
);

server.registerTool(
  "ig_get_hashtag_search",
  {
    description:
      "Search public Instagram posts by hashtag. Two-step: search hashtag ID → get recent media. Limited to 30 unique hashtags per 7-day rolling window.",
    inputSchema: {
      ...credentialFields,
      hashtag: z.string().describe("Hashtag to search (without #)"),
      limit: z
        .number()
        .optional()
        .describe("Number of results (default: 25, max: 50)"),
    },
  },
  safeHandler("ig_get_hashtag_search", async (args) => {
    if (!args.hashtag.trim())
      return errorResult("Invalid input", "hashtag cannot be empty");
    const result = await getClient(args, "ig_get_hashtag_search");
    if (!result.ok) return result.error;
    const { client } = result;

    // Step 1: Search for hashtag ID
    const hashtagClean = args.hashtag.replace(/^#/, "").trim();
    const searchResponse = await withRetry(() =>
      client.get<{ data: Array<{ id: string }> }>("/ig_hashtag_search", {
        q: hashtagClean,
        user_id: client.accountId,
      }),
    );

    if (!searchResponse.data?.[0]?.id) {
      return errorResult(
        "Hashtag not found",
        `No results for hashtag "${hashtagClean}".`,
      );
    }

    const hashtagId = searchResponse.data[0].id;

    // Step 2: Get recent media for the hashtag
    const mediaResponse = await withRetry(() =>
      client.get<{
        data: Array<{
          id: string;
          caption?: string;
          media_type: string;
          permalink?: string;
          like_count?: number;
          comments_count?: number;
          timestamp: string;
        }>;
      }>(`/${hashtagId}/recent_media`, {
        user_id: client.accountId,
        fields:
          "id,caption,media_type,permalink,like_count,comments_count,timestamp",
        limit: String(Math.min(args.limit || 25, 50)),
      }),
    );

    // Sanitize user-generated content
    const media = (mediaResponse.data || []).map((m) => ({
      id: m.id,
      caption: m.caption ? sanitize(m.caption) : null,
      mediaType: m.media_type,
      permalink: m.permalink,
      likeCount: m.like_count ?? 0,
      commentsCount: m.comments_count ?? 0,
      timestamp: m.timestamp,
    }));

    return senseResult(
      {
        hashtag: hashtagClean,
        hashtagId,
        media,
        count: media.length,
      },
      "Instagram",
    );
  }),
);

// =====================
// ACT Tools (write)
// =====================

/**
 * Poll a media container until its status is FINISHED or ERROR.
 * Used for reels where video processing is async.
 */
export async function pollContainerStatus(
  client: InstagramClient,
  containerId: string,
  maxAttempts = 12,
  initialWaitMs = 10_000,
): Promise<string> {
  let waitMs = initialWaitMs;
  for (let i = 0; i < maxAttempts; i++) {
    // Wait BEFORE checking — video processing never finishes instantly
    await sleep(waitMs);
    waitMs = Math.min(Math.ceil(waitMs * 1.5), 30_000);

    const status = await client.get<{
      status_code: string;
      status?: string;
    }>(`/${containerId}`, { fields: "status_code,status" });

    console.error(
      `[pollContainerStatus] Poll ${i + 1}/${maxAttempts}: ${status.status_code}`,
    );

    if (status.status_code === "FINISHED") return "FINISHED";
    if (status.status_code === "ERROR") {
      throw new Error(
        `Container processing failed: ${status.status || "unknown error"}`,
      );
    }
    // Anything other than IN_PROGRESS is an unexpected terminal state
    if (status.status_code !== "IN_PROGRESS") {
      throw new Error(
        `Container ${containerId} has unexpected status "${status.status_code}": ${status.status || "no detail"}. This may indicate an expired or invalid container.`,
      );
    }
  }

  throw new Error(
    `Container ${containerId} did not finish processing after ${maxAttempts} polls`,
  );
}

/**
 * Optionally post a top-level comment on a just-published Instagram media.
 * Returns { id } on success, { error } on failure, {} if no firstComment given.
 * Mirrors the LinkedIn first-comment contract: 3-5s random delay, 2200 char cap.
 */
export async function postFirstComment(
  client: InstagramClient,
  mediaId: string,
  firstComment: string | undefined,
): Promise<{ id?: string; error?: string }> {
  if (!firstComment?.trim()) return {};
  const commentText = firstComment.trim().slice(0, 2200);
  try {
    const delayMs = 3000 + Math.random() * 2000;
    console.error(
      `[postFirstComment] Posting first comment in ${Math.round(delayMs / 1000)}s...`,
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const response = await withRetry(() =>
      client.post<{ id: string }>(`/${mediaId}/comments`, {
        message: commentText,
      }),
    );
    return { id: response.id };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`[postFirstComment] First comment failed: ${errMsg}`);
    return { error: errMsg };
  }
}

server.registerTool(
  "ig_publish_photo",
  {
    description:
      "Publish a photo post to Instagram. The image_url must be publicly accessible. Flow: create media container → publish.",
    inputSchema: {
      ...credentialFields,
      imageUrl: z
        .string()
        .describe("Publicly accessible URL to the image. Must be JPEG or PNG."),
      caption: z
        .string()
        .optional()
        .describe(
          "Post caption (max 2200 characters). Supports #hashtags and @mentions.",
        ),
      firstComment: z
        .string()
        .optional()
        .describe(
          "Optional first comment posted immediately after publishing. Use for hashtags or a call-to-action. NOTE: links in Instagram comments are NOT clickable — do not use for bare URLs. Requires an IG Business account. Max 2200 chars.",
        ),
    },
  },
  safeHandler("ig_publish_photo", async (args) => {
    if (!args.imageUrl.trim())
      return errorResult("Invalid input", "imageUrl cannot be empty");
    if (args.caption && args.caption.length > 2200)
      return errorResult(
        "Invalid input",
        `Caption is ${args.caption.length} chars, max is 2200.`,
      );

    const result = await getClient(args, "ig_publish_photo");
    if (!result.ok) return result.error;
    const { client } = result;

    // Step 1: Create media container
    const container = await withRetry(() =>
      client.post<{ id: string }>(`/${client.accountId}/media`, {
        image_url: args.imageUrl,
        ...(args.caption && { caption: args.caption }),
      }),
    );

    // Step 2: Wait for Meta to fetch and process the image.
    // Photos usually finish in 1-5s but can take longer on slow image hosts.
    const status = await pollContainerStatus(client, container.id, 20, 1500);
    if (status !== "FINISHED") {
      return errorResult(
        "Container processing failed",
        `Photo container ${container.id} ended in status ${status}. Check that imageUrl is publicly accessible and returns a valid JPEG/PNG.`,
        {
          action:
            "INVALID_MEDIA: The image URL could not be processed. Verify it's publicly reachable, returns image/jpeg or image/png content-type, and is not behind a redirect.",
          containerId: container.id,
        },
      );
    }

    // Step 3: Publish
    const published = await withRetry(() =>
      client.post<{ id: string }>(`/${client.accountId}/media_publish`, {
        creation_id: container.id,
      }),
    );

    // Step 4: Optional first comment
    const commentResult = await postFirstComment(
      client,
      published.id,
      args.firstComment,
    );
    if (commentResult.error) {
      return errorResult(
        "Partial failure",
        `Media published (${published.id}) but first comment failed: ${commentResult.error}. Use ig_reply_comment to retry.`,
        { id: published.id, containerId: container.id },
      );
    }

    return textResult({
      id: published.id,
      containerId: container.id,
      ...(commentResult.id && { firstCommentId: commentResult.id }),
      message: commentResult.id
        ? "Photo published with first comment"
        : "Photo published successfully",
    });
  }),
);

server.registerTool(
  "ig_publish_carousel",
  {
    description:
      "Publish a carousel (multi-image) post to Instagram. Requires 2-10 items. Each item URL must be publicly accessible. Flow: create child containers → create parent container → publish.",
    inputSchema: {
      ...credentialFields,
      items: z
        .array(
          z.object({
            imageUrl: z.string().describe("Publicly accessible image URL"),
            isVideo: z
              .boolean()
              .optional()
              .describe("Set to true if this item is a video"),
          }),
        )
        .min(2)
        .max(10)
        .describe(
          "Carousel items (2-10). Each needs a publicly accessible media URL.",
        ),
      caption: z
        .string()
        .optional()
        .describe("Carousel caption (max 2200 characters)."),
      firstComment: z
        .string()
        .optional()
        .describe(
          "Optional first comment posted immediately after publishing. Use for hashtags or a call-to-action. NOTE: links in Instagram comments are NOT clickable — do not use for bare URLs. Requires an IG Business account. Max 2200 chars.",
        ),
    },
  },
  safeHandler("ig_publish_carousel", async (args) => {
    if (args.caption && args.caption.length > 2200)
      return errorResult(
        "Invalid input",
        `Caption is ${args.caption.length} chars, max is 2200.`,
      );

    const result = await getClient(args, "ig_publish_carousel");
    if (!result.ok) return result.error;
    const { client } = result;

    // Step 1: Create child containers (with partial failure tracking)
    const childIds: string[] = [];
    for (let i = 0; i < args.items.length; i++) {
      const item = args.items[i];
      if (!item.imageUrl.trim()) {
        return errorResult(
          "Invalid input",
          `Item ${i} in carousel has an empty URL.`,
          {
            action:
              "FIX_INPUT: Provide a valid publicly accessible URL for each carousel item.",
          },
        );
      }

      try {
        const child = await withRetry(() =>
          client.post<{ id: string }>(`/${client.accountId}/media`, {
            ...(item.isVideo
              ? { media_type: "VIDEO", video_url: item.imageUrl }
              : { media_type: "IMAGE", image_url: item.imageUrl }),
            is_carousel_item: true,
          }),
        );

        // Poll every child until FINISHED — both photos and videos can fail
        // if Meta hasn't finished fetching the remote media.
        console.error(
          `[ig_publish_carousel] Polling child ${i + 1}/${args.items.length} (${child.id})...`,
        );
        const childStatus = await pollContainerStatus(
          client,
          child.id,
          20,
          1500,
        );
        if (childStatus !== "FINISHED") {
          throw new Error(
            `Child container ${child.id} ended in status ${childStatus}. Verify the media URL is publicly reachable and returns a valid content-type.`,
          );
        }

        childIds.push(child.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(
          "Partial failure",
          `Carousel creation failed at item ${i + 1}/${args.items.length}: ${msg}`,
          {
            action:
              "PARTIAL_OPERATION: Child containers were created for items before the failure. These containers will auto-expire and do not need cleanup. Fix the failing item URL and retry the entire carousel. Note: retrying will consume another publish rate-limit token.",
            createdContainerIds: childIds,
            failedItemIndex: i,
            totalItems: args.items.length,
          },
        );
      }
    }

    // Step 2: Create parent carousel container
    const parent = await withRetry(() =>
      client.post<{ id: string }>(`/${client.accountId}/media`, {
        media_type: "CAROUSEL",
        children: childIds.join(","),
        ...(args.caption && { caption: args.caption }),
      }),
    );

    // Step 3: Publish
    const published = await withRetry(() =>
      client.post<{ id: string }>(`/${client.accountId}/media_publish`, {
        creation_id: parent.id,
      }),
    );

    // Step 4: Optional first comment
    const commentResult = await postFirstComment(
      client,
      published.id,
      args.firstComment,
    );
    if (commentResult.error) {
      return errorResult(
        "Partial failure",
        `Media published (${published.id}) but first comment failed: ${commentResult.error}. Use ig_reply_comment to retry.`,
        {
          id: published.id,
          containerId: parent.id,
          childContainerIds: childIds,
          itemCount: args.items.length,
        },
      );
    }

    return textResult({
      id: published.id,
      containerId: parent.id,
      childContainerIds: childIds,
      itemCount: args.items.length,
      ...(commentResult.id && { firstCommentId: commentResult.id }),
      message: commentResult.id
        ? "Carousel published with first comment"
        : "Carousel published successfully",
    });
  }),
);

server.registerTool(
  "ig_publish_reel",
  {
    description:
      "Publish a reel (short video) to Instagram. The video_url must be publicly accessible. Video processing is async — this tool polls until ready, then publishes.",
    inputSchema: {
      ...credentialFields,
      videoUrl: z
        .string()
        .describe(
          "Publicly accessible URL to the video. MP4 format recommended.",
        ),
      caption: z
        .string()
        .optional()
        .describe("Reel caption (max 2200 characters)."),
      coverUrl: z
        .string()
        .optional()
        .describe("Publicly accessible URL for a custom cover image."),
      shareToFeed: z
        .boolean()
        .optional()
        .describe("Also share to the main feed (default: true)."),
      firstComment: z
        .string()
        .optional()
        .describe(
          "Optional first comment posted immediately after publishing. Use for hashtags or a call-to-action. NOTE: links in Instagram comments are NOT clickable — do not use for bare URLs. Requires an IG Business account. Max 2200 chars.",
        ),
    },
  },
  safeHandler("ig_publish_reel", async (args) => {
    if (!args.videoUrl.trim())
      return errorResult("Invalid input", "videoUrl cannot be empty");
    if (args.caption && args.caption.length > 2200)
      return errorResult(
        "Invalid input",
        `Caption is ${args.caption.length} chars, max is 2200.`,
      );

    const result = await getClient(args, "ig_publish_reel");
    if (!result.ok) return result.error;
    const { client } = result;

    // Step 1: Create reel container
    const container = await withRetry(() =>
      client.post<{ id: string }>(`/${client.accountId}/media`, {
        media_type: "REELS",
        video_url: args.videoUrl,
        ...(args.caption && { caption: args.caption }),
        ...(args.coverUrl && { cover_url: args.coverUrl }),
        share_to_feed: args.shareToFeed !== false,
      }),
    );

    // Step 2: Poll until video processing is complete
    console.error(
      `[ig_publish_reel] Polling container ${container.id} for processing status...`,
    );
    await pollContainerStatus(client, container.id);

    // Step 3: Publish
    const published = await withRetry(() =>
      client.post<{ id: string }>(`/${client.accountId}/media_publish`, {
        creation_id: container.id,
      }),
    );

    // Step 4: Optional first comment
    const commentResult = await postFirstComment(
      client,
      published.id,
      args.firstComment,
    );
    if (commentResult.error) {
      return errorResult(
        "Partial failure",
        `Media published (${published.id}) but first comment failed: ${commentResult.error}. Use ig_reply_comment to retry.`,
        { id: published.id, containerId: container.id },
      );
    }

    return textResult({
      id: published.id,
      containerId: container.id,
      ...(commentResult.id && { firstCommentId: commentResult.id }),
      message: commentResult.id
        ? "Reel published with first comment"
        : "Reel published successfully",
    });
  }),
);

server.registerTool(
  "ig_reply_comment",
  {
    description: "Reply to a comment on an Instagram post.",
    inputSchema: {
      ...credentialFields,
      commentId: z.string().describe("ID of the comment to reply to"),
      message: z.string().describe("Reply text"),
    },
  },
  safeHandler("ig_reply_comment", async (args) => {
    if (!args.commentId.trim())
      return errorResult("Invalid input", "commentId cannot be empty");
    if (!args.message.trim())
      return errorResult("Invalid input", "message cannot be empty");

    const result = await getClient(args, "ig_reply_comment");
    if (!result.ok) return result.error;
    const { client } = result;

    const response = await withRetry(() =>
      client.post<{ id: string }>(`/${args.commentId}/replies`, {
        message: args.message,
      }),
    );

    return textResult({
      id: response.id,
      commentId: args.commentId,
      message: "Reply posted successfully",
    });
  }),
);

server.registerTool(
  "ig_delete_comment",
  {
    description: "Delete a comment on one of your Instagram posts.",
    inputSchema: {
      ...credentialFields,
      commentId: z.string().describe("ID of the comment to delete"),
    },
  },
  safeHandler("ig_delete_comment", async (args) => {
    if (!args.commentId.trim())
      return errorResult("Invalid input", "commentId cannot be empty");

    const result = await getClient(args, "ig_delete_comment");
    if (!result.ok) return result.error;
    const { client } = result;

    await withRetry(() => client.delete(`/${args.commentId}`));

    return textResult({
      commentId: args.commentId,
      message: "Comment deleted successfully",
    });
  }),
);

// --- Start ---

export { server };

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Instagram MCP Server running on stdio");
}

// Only start the stdio transport when invoked directly, not when imported
// by test files. Compares import.meta.url to the script entrypoint.
const isDirectRun =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
