/**
 * Regression tests for the #1995 first-comment partial-success contract (#1931).
 *
 * The whole point of first-comment publishing is "no lying success": if the
 * media publishes but the follow-up comment fails, the handler must surface a
 * partial failure — never a clean success. postFirstComment is the isolated
 * step the three publish handlers (photo/carousel/reel) all delegate to, so a
 * test here guards every IG publish path against the silent-swallow regression.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { postFirstComment } from "./index.js";
import type { InstagramClient } from "./client.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Drive the helper to completion, flushing its 3-5s natural-appearance delay. */
async function runWithTimers<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe("postFirstComment — partial-success contract", () => {
  it("returns the comment id when the comment posts", async () => {
    vi.useFakeTimers();
    const post = vi.fn().mockResolvedValue({ id: "comment-1" });
    const client = { post } as unknown as InstagramClient;

    const result = await runWithTimers(
      postFirstComment(client, "media-1", "Great thread →"),
    );

    expect(result).toEqual({ id: "comment-1" });
    expect(post).toHaveBeenCalledWith("/media-1/comments", {
      message: "Great thread →",
    });
  });

  it("returns { error } (NOT a clean success) when the comment client throws", async () => {
    vi.useFakeTimers();
    const post = vi.fn().mockRejectedValue(new Error("graph boom"));
    const client = { post } as unknown as InstagramClient;

    const result = await runWithTimers(
      postFirstComment(client, "media-1", "hi"),
    );

    // The media is already live; the failure must surface, never be swallowed.
    expect(result.error).toContain("graph boom");
    expect(result.id).toBeUndefined();
  });

  it("is a no-op (no API call) when firstComment is blank", async () => {
    const post = vi.fn();
    const client = { post } as unknown as InstagramClient;

    expect(await postFirstComment(client, "media-1", "   ")).toEqual({});
    expect(await postFirstComment(client, "media-1", undefined)).toEqual({});
    expect(post).not.toHaveBeenCalled();
  });

  it("caps the comment at Instagram's 2200-char limit", async () => {
    vi.useFakeTimers();
    const post = vi.fn().mockResolvedValue({ id: "c" });
    const client = { post } as unknown as InstagramClient;

    await runWithTimers(postFirstComment(client, "m", "y".repeat(4000)));

    const sent = post.mock.calls[0][1] as { message: string };
    expect(sent.message).toHaveLength(2200);
  });
});
