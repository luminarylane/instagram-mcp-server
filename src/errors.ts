/**
 * Error mapping helpers — pure functions only, no IO.
 *
 * extractApiDetail() formats an InstagramApiError for human/agent consumption.
 * suggestAction() maps (statusCode, detail) → an AGENT_ACTION hint string.
 *
 * These functions are pure and heavily unit-tested in errors.test.ts.
 * Every hint string is a regression guard for a real bug discovered during
 * live testing against the Instagram Graph API.
 */

import { InstagramApiError } from "./client.js";

export function extractApiDetail(e: unknown): string | undefined {
  if (e instanceof InstagramApiError) {
    const sub = e.errorSubcode ? ` (subcode: ${e.errorSubcode})` : "";
    return `${e.errorType}: ${e.message}${sub}`;
  }
  return undefined;
}

export function suggestAction(
  toolName: string,
  statusCode: number | undefined,
  detail: string | undefined,
  errorMsg?: string,
): string | undefined {
  const d = (detail || errorMsg || "").toLowerCase();

  // Network-level errors
  if (statusCode === undefined) {
    if (d.includes("enotfound") || d.includes("dns"))
      return "DNS_FAILURE: Cannot resolve graph.facebook.com. Check your internet connection.";
    if (d.includes("timeout") || d.includes("abort"))
      return "TIMEOUT: Request to Instagram timed out. Check your connection and retry.";
    if (d.includes("econnrefused") || d.includes("econnreset"))
      return "CONNECTION_FAILED: Cannot connect to Instagram. The service may be down. Retry in 30s.";
    if (d.includes("fetch failed"))
      return "NETWORK_ERROR: Network request failed. Check your internet connection and retry.";
    return undefined;
  }

  // Token-invalidity errors can come back as 400 with an OAuthException.
  // Match only explicit token-failure phrasing — NOT the bare word "oauth",
  // because OAuthException is the generic error type for all Graph API failures.
  if (
    d.includes("invalid oauth access token") ||
    d.includes("access token has expired") ||
    d.includes("session has expired") ||
    d.includes("access token is invalid") ||
    d.includes("cannot parse access token") ||
    d.includes("malformed access token")
  ) {
    return "AUTH_FAILED: Access token is invalid or expired. Generate a new long-lived token via the Facebook Developer Console.";
  }

  switch (statusCode) {
    case 400:
      if (
        (d.includes("invalid") && d.includes("media")) ||
        d.includes("photo or video can be accepted") ||
        d.includes("2207052") ||
        d.includes("2207027")
      )
        return "INVALID_MEDIA: The media URL is invalid or inaccessible. Ensure the URL is publicly accessible, returns image/jpeg or image/png content-type, is not behind a redirect, and is not rate-limited by the host.";
      if (d.includes("caption") || d.includes("too long"))
        return "CAPTION_TOO_LONG: Caption exceeds 2200 characters. Shorten it and retry.";
      if (d.includes("children") || d.includes("carousel"))
        return "INVALID_CAROUSEL: Carousel requires 2-10 items. Check item count and media URLs.";
      if (d.includes("hashtag"))
        return "INVALID_HASHTAG: Hashtag search is limited to 30 unique hashtags per 7-day rolling window.";
      return "INVALID_REQUEST: Check the error message and fix the input parameters.";

    case 401:
      return "AUTH_FAILED: Access token is invalid or expired. Generate a new long-lived token via the Facebook Developer Console.";

    case 403:
      if (d.includes("permission"))
        return "PERMISSION_DENIED: Your token lacks the required permission. Check token permissions in Facebook Developer Console.";
      if (d.includes("not approved") || d.includes("app not"))
        return "APP_NOT_APPROVED: Your Facebook app needs approval for this permission. Submit for review in the App Dashboard.";
      if (d.includes("business"))
        return "BUSINESS_ACCOUNT_REQUIRED: This feature requires an Instagram Business or Creator account linked to a Facebook Page.";
      return "FORBIDDEN: Instagram rejected this action. Check the error message for details.";

    case 404: {
      const t = toolName.toLowerCase();
      if (t.includes("comment"))
        return "COMMENT_NOT_FOUND: This comment may have been deleted. Skip it and move on.";
      if (t.includes("post") || t.includes("insight"))
        return "MEDIA_NOT_FOUND: This post may have been deleted or the ID is invalid. Skip it.";
      if (t.includes("story"))
        return "STORY_NOT_FOUND: Stories expire after 24 hours. This story is no longer available.";
      return "NOT_FOUND: The requested resource does not exist. It may have been deleted.";
    }

    case 429:
      return "RATE_LIMITED: Instagram rate limit hit after automatic retries. Wait 60s and retry, or switch to a different task.";

    case 500:
    case 502:
    case 503:
      return "SERVER_ERROR: Instagram is having issues. Wait 30s and retry once.";

    default:
      return undefined;
  }
}
