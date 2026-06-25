/**
 * Unit tests for error mapping helpers.
 *
 * Every test case here is a regression guard for a specific bug discovered
 * during live testing against the real Instagram Graph API. Changing any of
 * the asserted strings without updating the tool's error-handling docs is
 * a contract break for agents consuming these responses.
 */

import { describe, it, expect } from "vitest";
import { extractApiDetail, suggestAction } from "./errors.js";
import { InstagramApiError } from "./client.js";

describe("extractApiDetail", () => {
  it("returns undefined for non-InstagramApiError values", () => {
    expect(extractApiDetail(new Error("boom"))).toBeUndefined();
    expect(extractApiDetail("string error")).toBeUndefined();
    expect(extractApiDetail(null)).toBeUndefined();
    expect(extractApiDetail(undefined)).toBeUndefined();
  });

  it("formats InstagramApiError without subcode", () => {
    const err = new InstagramApiError(400, {
      message: "Invalid OAuth access token - Cannot parse access token",
      type: "OAuthException",
      code: 190,
    });
    expect(extractApiDetail(err)).toBe(
      "OAuthException: Invalid OAuth access token - Cannot parse access token",
    );
  });

  it("formats InstagramApiError with subcode", () => {
    const err = new InstagramApiError(400, {
      message: "Media ID is not available",
      type: "OAuthException",
      code: 100,
      error_subcode: 2207027,
    });
    expect(extractApiDetail(err)).toBe(
      "OAuthException: Media ID is not available (subcode: 2207027)",
    );
  });
});

describe("suggestAction — network errors (no statusCode)", () => {
  it("ENOTFOUND → DNS_FAILURE", () => {
    const r = suggestAction(
      "ig_get_account_insights",
      undefined,
      undefined,
      "getaddrinfo ENOTFOUND graph.facebook.com",
    );
    expect(r).toMatch(/^DNS_FAILURE:/);
  });

  it("timeout → TIMEOUT", () => {
    expect(
      suggestAction(
        "ig_get_comments",
        undefined,
        undefined,
        "The operation was aborted due to timeout",
      ),
    ).toMatch(/^TIMEOUT:/);
  });

  it("ECONNREFUSED → CONNECTION_FAILED", () => {
    expect(
      suggestAction(
        "ig_get_comments",
        undefined,
        undefined,
        "connect ECONNREFUSED 31.13.84.4:443",
      ),
    ).toMatch(/^CONNECTION_FAILED:/);
  });

  it("fetch failed → NETWORK_ERROR", () => {
    expect(
      suggestAction("ig_get_comments", undefined, undefined, "fetch failed"),
    ).toMatch(/^NETWORK_ERROR:/);
  });

  it("unknown network error → undefined", () => {
    expect(
      suggestAction("ig_get_comments", undefined, undefined, "something weird"),
    ).toBeUndefined();
  });
});

describe("suggestAction — token errors (high priority for Bug #6)", () => {
  it("'Invalid OAuth access token' → AUTH_FAILED", () => {
    const r = suggestAction(
      "ig_get_account_insights",
      400,
      "OAuthException: Invalid OAuth access token - Cannot parse access token",
    );
    expect(r).toMatch(/^AUTH_FAILED:/);
  });

  it("'Cannot parse access token' → AUTH_FAILED", () => {
    expect(suggestAction("any", 400, "Cannot parse access token")).toMatch(
      /^AUTH_FAILED:/,
    );
  });

  it("'access token has expired' → AUTH_FAILED", () => {
    expect(
      suggestAction(
        "any",
        400,
        "Error validating access token: access token has expired",
      ),
    ).toMatch(/^AUTH_FAILED:/);
  });

  it("'session has expired' → AUTH_FAILED", () => {
    expect(
      suggestAction("any", 400, "The session has expired on Tuesday"),
    ).toMatch(/^AUTH_FAILED:/);
  });

  it("'malformed access token' → AUTH_FAILED", () => {
    expect(suggestAction("any", 400, "Malformed access token")).toMatch(
      /^AUTH_FAILED:/,
    );
  });

  // REGRESSION: generic OAuthException for metric errors must NOT be AUTH_FAILED
  it("metric error mentioning OAuthException is NOT AUTH_FAILED", () => {
    const metricErr =
      "OAuthException: (#100) metric[2] must be one of the following values: reach, follower_count, profile_views";
    const r = suggestAction("ig_get_stories_insights", 400, metricErr);
    expect(r).not.toMatch(/^AUTH_FAILED:/);
    expect(r).toMatch(/^INVALID_REQUEST:/);
  });
});

describe("suggestAction — 400 media errors (regression guard for Bug #9)", () => {
  it("'photo or video can be accepted' → INVALID_MEDIA", () => {
    const r = suggestAction(
      "ig_publish_photo",
      400,
      "OAuthException: Only photo or video can be accepted as media type. (subcode: 2207052)",
    );
    expect(r).toMatch(/^INVALID_MEDIA:/);
  });

  it("subcode 2207052 → INVALID_MEDIA", () => {
    expect(
      suggestAction(
        "ig_publish_carousel",
        400,
        "Some error text (subcode: 2207052)",
      ),
    ).toMatch(/^INVALID_MEDIA:/);
  });

  it("subcode 2207027 → INVALID_MEDIA", () => {
    expect(
      suggestAction(
        "ig_publish_photo",
        400,
        "Media ID is not available (subcode: 2207027)",
      ),
    ).toMatch(/^INVALID_MEDIA:/);
  });

  it("'invalid media URL' → INVALID_MEDIA", () => {
    expect(
      suggestAction("ig_publish_photo", 400, "Invalid media URL provided"),
    ).toMatch(/^INVALID_MEDIA:/);
  });
});

describe("suggestAction — other 400 branches", () => {
  it("caption mention → CAPTION_TOO_LONG", () => {
    expect(
      suggestAction("ig_publish_photo", 400, "Caption is too long"),
    ).toMatch(/^CAPTION_TOO_LONG:/);
  });

  it("'too long' → CAPTION_TOO_LONG", () => {
    expect(suggestAction("ig_publish_photo", 400, "Value too long")).toMatch(
      /^CAPTION_TOO_LONG:/,
    );
  });

  it("carousel children error → INVALID_CAROUSEL", () => {
    expect(
      suggestAction(
        "ig_publish_carousel",
        400,
        "Carousel children must be between 2 and 10",
      ),
    ).toMatch(/^INVALID_CAROUSEL:/);
  });

  it("hashtag error → INVALID_HASHTAG", () => {
    expect(
      suggestAction("ig_get_hashtag_search", 400, "Hashtag quota exceeded"),
    ).toMatch(/^INVALID_HASHTAG:/);
  });

  it("unmatched 400 → INVALID_REQUEST", () => {
    expect(suggestAction("any", 400, "Unknown bad request reason")).toMatch(
      /^INVALID_REQUEST:/,
    );
  });
});

describe("suggestAction — 401/403/404", () => {
  it("401 → AUTH_FAILED", () => {
    expect(suggestAction("any", 401, "anything")).toMatch(/^AUTH_FAILED:/);
  });

  it("403 with 'permission' → PERMISSION_DENIED", () => {
    expect(
      suggestAction("any", 403, "You lack the required permission"),
    ).toMatch(/^PERMISSION_DENIED:/);
  });

  it("403 with 'not approved' → APP_NOT_APPROVED", () => {
    expect(
      suggestAction("any", 403, "This feature is not approved for your app"),
    ).toMatch(/^APP_NOT_APPROVED:/);
  });

  it("403 with 'business' → BUSINESS_ACCOUNT_REQUIRED", () => {
    expect(suggestAction("any", 403, "A business account is required")).toMatch(
      /^BUSINESS_ACCOUNT_REQUIRED:/,
    );
  });

  it("403 unmatched → FORBIDDEN", () => {
    expect(suggestAction("any", 403, "generic denial")).toMatch(/^FORBIDDEN:/);
  });

  it("404 comment tool → COMMENT_NOT_FOUND", () => {
    expect(suggestAction("ig_delete_comment", 404, "not found")).toMatch(
      /^COMMENT_NOT_FOUND:/,
    );
  });

  it("404 insight tool → MEDIA_NOT_FOUND", () => {
    expect(suggestAction("ig_get_post_insights", 404, "not found")).toMatch(
      /^MEDIA_NOT_FOUND:/,
    );
  });

  it("404 story tool → STORY_NOT_FOUND", () => {
    // Tool name must include 'story' AND NOT 'insight' / 'post' / 'comment'
    // (those are checked first). ig_story_publish is a hypothetical example.
    expect(suggestAction("ig_story_fetch", 404, "not found")).toMatch(
      /^STORY_NOT_FOUND:/,
    );
  });

  // Real-world: ig_get_stories_insights contains both 'story' and 'insight',
  // and 'insight' is checked first → MEDIA_NOT_FOUND (documented quirk).
  it("404 ig_get_stories_insights → MEDIA_NOT_FOUND (insight wins)", () => {
    expect(suggestAction("ig_get_stories_insights", 404, "not found")).toMatch(
      /^MEDIA_NOT_FOUND:/,
    );
  });

  it("404 generic tool → NOT_FOUND", () => {
    expect(suggestAction("ig_misc_tool", 404, "not found")).toMatch(
      /^NOT_FOUND:/,
    );
  });
});

describe("suggestAction — 429 and 5xx", () => {
  it("429 → RATE_LIMITED", () => {
    expect(suggestAction("any", 429, "rate limited")).toMatch(/^RATE_LIMITED:/);
  });

  it("500 → SERVER_ERROR", () => {
    expect(suggestAction("any", 500, "internal server error")).toMatch(
      /^SERVER_ERROR:/,
    );
  });

  it("502 → SERVER_ERROR", () => {
    expect(suggestAction("any", 502, "bad gateway")).toMatch(/^SERVER_ERROR:/);
  });

  it("503 → SERVER_ERROR", () => {
    expect(suggestAction("any", 503, "service unavailable")).toMatch(
      /^SERVER_ERROR:/,
    );
  });

  it("unknown status → undefined", () => {
    expect(suggestAction("any", 418, "I'm a teapot")).toBeUndefined();
  });
});
