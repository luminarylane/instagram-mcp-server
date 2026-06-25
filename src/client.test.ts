/**
 * Unit tests for the Graph API HTTP client.
 *
 * Uses vi.stubGlobal("fetch", ...) to stub network calls. Every test resets
 * the stub in afterEach to prevent leakage. The most important test here is
 * the one asserting GRAPH_API_BASE points at graph.facebook.com — it's a
 * regression guard for Bug #1 discovered during live testing (the scaffold
 * incorrectly used graph.instagram.com which rejects Facebook Login tokens).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  createClient,
  InstagramApiError,
  InstagramClient,
  type Credentials,
} from "./client.js";

// Reach into the module's source to read the base URL constant.
// We assert on actual request URLs below, which is the real contract.

const creds: Credentials = {
  accessToken: "EAALtest123",
  accountId: "17841400000000000",
};

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function mockFetchOk(body: unknown, init: ResponseInit = {}): FetchMock {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
      }),
  );
}

function mockFetchError(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): FetchMock {
  return vi.fn<typeof fetch>(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
  );
}

describe("InstagramClient — URL construction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GET builds URL against graph.facebook.com/v21.0 (REGRESSION: Bug #1)", async () => {
    const fetchMock = mockFetchOk({ data: [] });
    vi.stubGlobal("fetch", fetchMock);

    const client = new InstagramClient(creds);
    await client.get("/17841400000000000/insights");

    const [url] = fetchMock.mock.calls[0];
    expect(url.toString()).toMatch(
      /^https:\/\/graph\.facebook\.com\/v21\.0\/17841400000000000\/insights\?/,
    );
  });

  it("GET puts access_token and extra params in query string", async () => {
    const fetchMock = mockFetchOk({ data: [] });
    vi.stubGlobal("fetch", fetchMock);

    const client = new InstagramClient(creds);
    await client.get("/17841400000000000/insights", {
      metric: "reach,profile_views",
      period: "day",
    });

    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("access_token")).toBe("EAALtest123");
    expect(url.searchParams.get("metric")).toBe("reach,profile_views");
    expect(url.searchParams.get("period")).toBe("day");
  });

  it("POST sends JSON body with correct Content-Type", async () => {
    const fetchMock = mockFetchOk({ id: "new_media_id" });
    vi.stubGlobal("fetch", fetchMock);

    const client = new InstagramClient(creds);
    await client.post("/17841400000000000/media", {
      image_url: "https://example.com/test.jpg",
      caption: "hello",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init?.body as string)).toEqual({
      image_url: "https://example.com/test.jpg",
      caption: "hello",
    });
  });

  it("POST includes access_token in query even when body is present", async () => {
    const fetchMock = mockFetchOk({ id: "x" });
    vi.stubGlobal("fetch", fetchMock);

    const client = new InstagramClient(creds);
    await client.post("/17841400000000000/media_publish", {
      creation_id: "abc",
    });

    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get("access_token")).toBe("EAALtest123");
  });

  it("DELETE sends DELETE method", async () => {
    const fetchMock = mockFetchOk({ success: true });
    vi.stubGlobal("fetch", fetchMock);

    const client = new InstagramClient(creds);
    await client.delete("/comment_id_123");

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe("DELETE");
  });
});

describe("InstagramClient — error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses Graph API error into InstagramApiError with status/code/subcode", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchError(400, {
        error: {
          message: "Invalid OAuth access token",
          type: "OAuthException",
          code: 190,
          error_subcode: 460,
          fbtrace_id: "abc123",
        },
      }),
    );

    const client = new InstagramClient(creds);
    await expect(client.get("/me")).rejects.toMatchObject({
      name: "InstagramApiError",
      status: 400,
      code: 190,
      errorSubcode: 460,
      errorType: "OAuthException",
      message: "Invalid OAuth access token",
    });
  });

  it("wraps non-JSON HTML error responses in InstagramApiError", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new InstagramClient(creds);
    await expect(client.get("/me")).rejects.toMatchObject({
      status: 502,
      errorType: "ParseError",
    });
  });

  it("passes through Retry-After header as retryAfter", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchError(
        429,
        {
          error: {
            message: "Rate limited",
            type: "OAuthException",
            code: 4,
          },
        },
        { "Retry-After": "90" },
      ),
    );

    const client = new InstagramClient(creds);
    try {
      await client.get("/me");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InstagramApiError);
      expect((e as InstagramApiError).retryAfter).toBe(90);
    }
  });

  it("wraps non-GraphAPI JSON error shapes in UnknownError", async () => {
    vi.stubGlobal("fetch", mockFetchError(500, { something: "weird" }));

    const client = new InstagramClient(creds);
    await expect(client.get("/me")).rejects.toMatchObject({
      status: 500,
      errorType: "UnknownError",
    });
  });
});

describe("createClient — caching", () => {
  beforeEach(() => {
    // Clear module state between tests by re-requiring isn't straightforward
    // in ESM. Instead we rely on the fact that each cache key includes the
    // full token+account pair — using unique tokens per test keeps them
    // isolated.
  });

  it("returns the same instance for identical credentials", () => {
    const a = createClient({ accessToken: "tok_same", accountId: "acc_1" });
    const b = createClient({ accessToken: "tok_same", accountId: "acc_1" });
    expect(a).toBe(b);
  });

  it("returns different instances for different tokens", () => {
    const a = createClient({ accessToken: "tok_A_unique", accountId: "acc_x" });
    const b = createClient({ accessToken: "tok_B_unique", accountId: "acc_x" });
    expect(a).not.toBe(b);
  });

  it("returns different instances for different account IDs", () => {
    const a = createClient({ accessToken: "tok_shared", accountId: "acc_1_u" });
    const b = createClient({ accessToken: "tok_shared", accountId: "acc_2_u" });
    expect(a).not.toBe(b);
  });

  it("returned clients carry the provided creds", () => {
    const client = createClient({
      accessToken: "tok_readback",
      accountId: "acc_readback",
    });
    expect(client.accessToken).toBe("tok_readback");
    expect(client.accountId).toBe("acc_readback");
  });
});

describe("InstagramApiError — shape", () => {
  it("carries all graph-api error fields", () => {
    const err = new InstagramApiError(
      400,
      {
        message: "boom",
        type: "OAuthException",
        code: 100,
        error_subcode: 2207052,
      },
      30,
    );

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InstagramApiError");
    expect(err.status).toBe(400);
    expect(err.code).toBe(100);
    expect(err.errorSubcode).toBe(2207052);
    expect(err.errorType).toBe("OAuthException");
    expect(err.retryAfter).toBe(30);
    expect(err.message).toBe("boom");
  });

  it("allows undefined subcode and retryAfter", () => {
    const err = new InstagramApiError(500, {
      message: "server error",
      type: "InternalError",
      code: 1,
    });
    expect(err.errorSubcode).toBeUndefined();
    expect(err.retryAfter).toBeUndefined();
  });
});
