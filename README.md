# Instagram MCP Server

[![MCP](https://img.shields.io/badge/MCP-1.0-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

A Model Context Protocol (MCP) server that connects Claude Desktop (and other MCP clients) to the Instagram Graph API — read analytics, manage comments, publish photos, carousels, and reels.

## Features

### 11 Instagram Tools

**SENSE (read-only):**
| Tool | Description |
|------|-------------|
| `ig_get_account_insights` | Account insights: reach, follower growth, profile views over a period |
| `ig_get_post_insights` | Engagement metrics for a specific post: reach, likes, shares, saves |
| `ig_get_comments` | Comments on a post with username, timestamp, and replies |
| `ig_get_stories_insights` | Insights for an active story: reach, replies, interactions |
| `ig_get_audience_demographics` | Follower demographics: city, country, age/gender breakdown |
| `ig_get_hashtag_search` | Search public posts by hashtag (30 unique hashtags per 7-day window) |

**ACT (write):**
| Tool | Description |
|------|-------------|
| `ig_publish_photo` | Publish a photo post from a public URL |
| `ig_publish_carousel` | Publish a carousel (2-10 images) from public URLs |
| `ig_publish_reel` | Publish a reel (short video) from a public URL |
| `ig_reply_comment` | Reply to a comment on a post |
| `ig_delete_comment` | Delete a comment on one of your posts |

### Built-in Reliability

- **Per-tenant rate limiting** — token-bucket rate limiter keyed by IG Business Account ID
- **Exponential backoff retry** — automatic retry with jitter for transient API errors
- **Container-based publishing** — create container → poll status → publish (handles async video processing)
- **Input sanitization** — strips zero-width characters, normalizes whitespace, truncates to API limits
- **Prompt injection protection** — wraps external API data in randomized markers

## Quick Start

### Prerequisites

- Node.js 18+
- An Instagram Business or Creator account connected to a Facebook Page
- A Facebook App with the Instagram Graph API enabled
- A long-lived Page Access Token

### Getting Your Access Token

1. Create a [Facebook App](https://developers.facebook.com/apps/)
2. Add the **Instagram Graph API** product
3. In [Graph API Explorer](https://developers.facebook.com/tools/explorer/), generate a Page Access Token with these permissions:
   - `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`
4. [Extend the token](https://developers.facebook.com/tools/debug/accesstoken/) to a long-lived token (60 days)

### Installation

```bash
git clone https://github.com/luminarylane/instagram-mcp-server.git
cd instagram-mcp-server
npm install
npm run build
```

### Configuration

**Claude Desktop (`claude_desktop_config.json`):**

```json
{
  "mcpServers": {
    "instagram": {
      "command": "node",
      "args": ["/path/to/instagram-mcp-server/dist/index.js"],
      "env": {
        "INSTAGRAM_ACCESS_TOKEN": "your_long_lived_page_token",
        "INSTAGRAM_BUSINESS_ACCOUNT_ID": "your_17_digit_ig_business_account_id"
      }
    }
  }
}
```

**Environment variables:**

| Variable                        | Required | Description                           |
| ------------------------------- | -------- | ------------------------------------- |
| `INSTAGRAM_ACCESS_TOKEN`        | Yes\*    | Long-lived Facebook Page Access Token |
| `INSTAGRAM_BUSINESS_ACCOUNT_ID` | Yes\*    | 17-digit IG Business Account ID       |

\*Can also be passed per-call via tool arguments.

### Finding Your Business Account ID

Use the Graph API Explorer:

```
GET /me/accounts?fields=instagram_business_account
```

The `instagram_business_account.id` field is your Business Account ID.

## Usage Examples

Once configured, ask Claude to:

- "Show me my Instagram account insights for the last 28 days"
- "What are the engagement metrics for my latest post?"
- "Get the comments on this post" (paste a media ID)
- "Show my follower demographics by country"
- "Publish this photo to Instagram" (provide a public image URL + caption)
- "Create a carousel post with these images"
- "Reply to this comment with 'Thanks!'"
- "Search recent posts with #startup"

## Publishing

Photo and carousel publishing is synchronous — the tool returns once the post is live. Reel publishing is asynchronous — the server polls the container status until processing completes, then publishes.

All publish tools accept an optional `firstComment` parameter to add a comment immediately after publishing (commonly used for hashtags).

## Rate Limiting

The server enforces per-account rate limits to stay within Instagram's API quotas. If you hit a rate limit, the tool will return an error with a suggested retry time. The built-in retry logic handles transient 429 responses automatically.

## Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make changes and run tests (`npm test`)
4. Submit a pull request

## License

MIT License — see [LICENSE](LICENSE) for details.

## Acknowledgments

- [Anthropic](https://anthropic.com) for the MCP specification
- [Meta Graph API](https://developers.facebook.com/docs/instagram-api/) for the underlying Instagram API
