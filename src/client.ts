/**
 * Instagram Graph API client.
 *
 * Raw fetch wrapper against Facebook Graph API (for Facebook-Login/Page tokens)
 * or Instagram Graph API (for Instagram Login tokens). No SDK — keeps
 * dependencies minimal (Occam's Razor). Client instances are cached by
 * credential + tokenType hash.
 */

import { createHash } from "node:crypto";

const CLIENT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export type InstagramTokenType = "facebook_page" | "instagram_login";

const GRAPH_API_BASE: Record<InstagramTokenType, string> = {
  facebook_page: "https://graph.facebook.com/v21.0",
  instagram_login: "https://graph.instagram.com/v21.0",
};

export interface Credentials {
  accessToken: string;
  accountId: string;
  tokenType?: InstagramTokenType;
}

interface CachedClient {
  client: InstagramClient;
  createdAt: number;
}

const clientCache = new Map<string, CachedClient>();

function credentialHash(creds: Credentials): string {
  const raw = `${creds.accessToken}:${creds.accountId}:${creds.tokenType ?? "facebook_page"}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/**
 * Get or create a cached Instagram client.
 */
export function createClient(creds: Credentials): InstagramClient {
  const key = credentialHash(creds);
  const now = Date.now();

  // Evict stale entries on every call
  for (const [k, v] of clientCache) {
    if (now - v.createdAt >= CLIENT_TTL_MS) {
      clientCache.delete(k);
    }
  }

  const cached = clientCache.get(key);
  if (cached) return cached.client;

  const client = new InstagramClient(creds);
  clientCache.set(key, { client, createdAt: now });
  return client;
}

/**
 * Graph API error format from Facebook/Instagram.
 */
export interface GraphApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

function isGraphApiError(body: unknown): body is GraphApiError {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as GraphApiError).error === "object" &&
    typeof (body as GraphApiError).error.message === "string"
  );
}

/**
 * Error thrown for Graph API failures. Carries structured error data
 * for suggestAction() to inspect.
 */
export class InstagramApiError extends Error {
  readonly status: number;
  readonly code: number;
  readonly errorSubcode?: number;
  readonly errorType: string;
  readonly retryAfter?: number;

  constructor(
    status: number,
    apiError: GraphApiError["error"],
    retryAfter?: number,
  ) {
    super(apiError.message);
    this.name = "InstagramApiError";
    this.status = status;
    this.code = apiError.code;
    this.errorSubcode = apiError.error_subcode;
    this.errorType = apiError.type;
    this.retryAfter = retryAfter;
  }
}

export class InstagramClient {
  readonly accessToken: string;
  readonly accountId: string;
  readonly tokenType: InstagramTokenType;
  private readonly baseUrl: string;

  constructor(creds: Credentials) {
    this.accessToken = creds.accessToken;
    this.accountId = creds.accountId;
    this.tokenType = creds.tokenType ?? "facebook_page";
    this.baseUrl = GRAPH_API_BASE[this.tokenType];
  }

  /**
   * Make a GET request to the Graph API.
   */
  async get<T = unknown>(
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("access_token", this.accessToken);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
    });

    return this.handleResponse<T>(res);
  }

  /**
   * Make a POST request to the Graph API.
   */
  async post<T = unknown>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("access_token", this.accessToken);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    return this.handleResponse<T>(res);
  }

  /**
   * Make a DELETE request to the Graph API.
   */
  async delete<T = unknown>(path: string): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("access_token", this.accessToken);

    const res = await fetch(url, {
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
    });

    return this.handleResponse<T>(res);
  }

  private async handleResponse<T>(res: Response): Promise<T> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      // Non-JSON response (HTML error page during outage, empty body, etc.)
      throw new InstagramApiError(res.status, {
        message: `HTTP ${res.status}: Response is not valid JSON (likely an outage or proxy error)`,
        type: "ParseError",
        code: res.status,
      });
    }

    if (!res.ok) {
      const retryAfterHeader = res.headers.get("Retry-After");
      const seconds = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
      const retryAfter = !isNaN(seconds) ? seconds : undefined;

      if (isGraphApiError(body)) {
        throw new InstagramApiError(res.status, body.error, retryAfter);
      }

      // Non-standard error response — wrap in a generic error
      throw new InstagramApiError(
        res.status,
        {
          message: `HTTP ${res.status}: ${JSON.stringify(body)}`,
          type: "UnknownError",
          code: res.status,
        },
        retryAfter,
      );
    }

    return body as T;
  }
}
