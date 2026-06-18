/**
 * Pure SENSE/insights functions for the Instagram Graph API.
 *
 * Same pattern as Facebook's `lib/insights.ts` — single source of truth
 * for both the MCP server's tool handlers and the web app's
 * `platform-insights.ts` orchestrator (importing via `@instagram-mcp/lib`).
 */
import type { InstagramClient } from "../client.js";
import { withRetry } from "../rate-limiter.js";

// ---------------------------------------------------------------------------
// ig_get_account_insights
// ---------------------------------------------------------------------------

export interface AccountInsightsArgs {
  /** "day" | "week" | "days_28". Default: "day". */
  period?: string;
  /** Unix timestamp (string), inclusive. */
  since?: string;
  /** Unix timestamp (string), inclusive. */
  until?: string;
}

export interface AccountInsightsResult {
  period: string;
  insights: unknown[];
}

const ACCOUNT_INSIGHTS_METRICS = "reach,profile_views,accounts_engaged";

export async function fetchAccountInsights(
  client: InstagramClient,
  args: AccountInsightsArgs = {},
): Promise<AccountInsightsResult> {
  const params: Record<string, string> = {
    metric: ACCOUNT_INSIGHTS_METRICS,
    metric_type: "total_value",
    period: args.period || "day",
  };
  if (args.since) params.since = args.since;
  if (args.until) params.until = args.until;

  const response = await withRetry(() =>
    client.get<{ data: unknown[] }>(`/${client.accountId}/insights`, params),
  );

  return { insights: response.data, period: params.period };
}

// ---------------------------------------------------------------------------
// ig_get_post_insights
// ---------------------------------------------------------------------------

export interface PostInsightsArgs {
  mediaId: string;
}

export interface PostInsightsResult {
  mediaId: string;
  insights: unknown[];
}

const POST_INSIGHTS_METRICS =
  "reach,likes,comments,shares,saved,total_interactions,views";

export async function fetchPostInsights(
  client: InstagramClient,
  args: PostInsightsArgs,
): Promise<PostInsightsResult> {
  if (!args.mediaId.trim()) throw new Error("mediaId cannot be empty");
  const response = await withRetry(() =>
    client.get<{ data: unknown[] }>(`/${args.mediaId}/insights`, {
      metric: POST_INSIGHTS_METRICS,
    }),
  );
  return { mediaId: args.mediaId, insights: response.data };
}

// ---------------------------------------------------------------------------
// ig_get_audience_demographics
// ---------------------------------------------------------------------------

export type DemographicsMetric =
  | "follower_demographics"
  | "engaged_audience_demographics"
  | "reached_audience_demographics";

export type DemographicsBreakdown = "age" | "city" | "country" | "gender";

export interface AudienceDemographicsArgs {
  metric?: DemographicsMetric;
  breakdown?: DemographicsBreakdown;
}

export interface AudienceDemographicsResult {
  demographics: unknown[];
}

export async function fetchAudienceDemographics(
  client: InstagramClient,
  args: AudienceDemographicsArgs = {},
): Promise<AudienceDemographicsResult> {
  const metric = args.metric || "follower_demographics";
  const breakdown = args.breakdown || "country";

  const response = await withRetry(() =>
    client.get<{ data: unknown[] }>(`/${client.accountId}/insights`, {
      metric,
      period: "lifetime",
      metric_type: "total_value",
      breakdown,
    }),
  );

  return { demographics: response.data };
}

// ---------------------------------------------------------------------------
// Recent media list — derived helper used by the web orchestrator to compute
// per-post averages without making a separate ig_get_post_insights call per
// media. NOT exposed as an MCP tool today (the MCP server only fetches by
// mediaId), but we keep it here for parity with Facebook's fetchPageFeed.
// ---------------------------------------------------------------------------

export interface RecentMediaArgs {
  /** Default 10, max 100. */
  limit?: number;
}

export interface IgMedia {
  id: string;
  mediaType?: string;
  permalink?: string;
  likeCount?: number;
  commentsCount?: number;
  reach?: number;
  totalInteractions?: number;
}

export async function fetchRecentMedia(
  client: InstagramClient,
  args: RecentMediaArgs = {},
): Promise<{ media: IgMedia[] }> {
  const limit = Math.max(1, Math.min(args.limit || 10, 100));
  const response = await withRetry(() =>
    client.get<{
      data: Array<{
        id: string;
        media_type?: string;
        permalink?: string;
        like_count?: number;
        comments_count?: number;
        insights?: {
          data?: Array<{ name: string; values?: Array<{ value: number }> }>;
        };
      }>;
    }>(`/${client.accountId}/media`, {
      fields:
        "id,media_type,permalink,like_count,comments_count," +
        "insights.metric(reach,total_interactions)",
      limit: String(limit),
    }),
  );

  const media: IgMedia[] = (response.data || []).map((m) => {
    const metricMap: Record<string, number> = {};
    for (const x of m.insights?.data ?? []) {
      metricMap[x.name] = x.values?.[0]?.value ?? 0;
    }
    return {
      id: m.id,
      mediaType: m.media_type,
      permalink: m.permalink,
      likeCount: m.like_count,
      commentsCount: m.comments_count,
      reach: metricMap.reach,
      totalInteractions: metricMap.total_interactions,
    };
  });

  return { media };
}
