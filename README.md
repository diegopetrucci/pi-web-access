# pi-web-access (TLH fork)

Exa-only web search and URL fetching for the Pi coding agent — trimmed, isolated, and safe.

## Status

This is a fork maintained by [Diego Petrucci](https://github.com/diegopetrucci) as part of
[The Last Harness](https://github.com/diegopetrucci/the-last-harness). See [NOTICE](NOTICE)
for upstream attribution and [CHANGELOG.md](CHANGELOG.md) for the full list of changes
relative to the upstream `nicobailon/pi-web-access`.

> **Note:** Running this fork alongside the upstream `pi-web-access` at the same time is
> unsupported — both expose the same tool names (`web_search`, `fetch_content`,
> `get_search_content`). Install only one.

## Tools

| Tool | Description |
|------|-------------|
| `web_search` | Search the web via Exa. Returns a synthesised answer with source citations. |
| `fetch_content` | Fetch one or more URLs and extract readable content as markdown. |
| `get_search_content` | Retrieve full stored content from a previous search or fetch (content over 30 000 chars is truncated in tool responses but stored in full). |

### web_search

```typescript
web_search({ query: "TypeScript best practices 2025" })
web_search({ queries: ["query 1", "query 2"] })
web_search({ query: "latest news", numResults: 10, recencyFilter: "week" })
web_search({ query: "...", domainFilter: ["github.com"] })
web_search({ query: "...", includeContent: true })
```

| Parameter | Description |
|-----------|-------------|
| `query` / `queries` | Single query or batch of queries |
| `numResults` | Results per query (default: 5, max: 20) |
| `recencyFilter` | `day`, `week`, `month`, or `year` |
| `domainFilter` | Limit to domains (prefix with `-` to exclude) |
| `includeContent` | Fetch full page content from sources alongside results |

### fetch_content

```typescript
fetch_content({ url: "https://example.com/article" })
fetch_content({ urls: ["url1", "url2", "url3"] })
```

| Parameter | Description |
|-----------|-------------|
| `url` / `urls` | Single URL or multiple URLs to fetch |

### get_search_content

```typescript
get_search_content({ responseId: "abc123", urlIndex: 0 })
get_search_content({ responseId: "abc123", url: "https://..." })
```

## Configuration

Settings file: `$PI_CODING_AGENT_DIR/extensions/pi-web-access/settings.json`

```json
{
  "exaApiKey": "exa-..."
}
```

### EXA key precedence

1. **Explicit setting** — `exaApiKey` in the settings file above.
2. **`EXA_API_KEY` environment variable** — used when no settings-file key is present.
3. **Exa MCP fallback** — zero-config, unauthenticated; used when no key is found at all.
   Limited to 1 000 requests/month on the free tier.

> **Privacy:** The API key is never persisted to disk during settings merges unless
> you explicitly set it in the settings file. An env-var key stays in memory only.

To disable this extension:

```sh
tlh defaults disable pi-web-access
```

## Migrating from upstream pi-web-access

This fork stores all config and cache under `PI_CODING_AGENT_DIR` (the TLH
isolated profile directory). It will **not** read `~/.pi/web-search.json`
automatically. If you have an existing key file there, copy it manually:

```sh
mkdir -p "${PI_CODING_AGENT_DIR}/extensions/pi-web-access" && \
  cp ~/.pi/web-search.json "${PI_CODING_AGENT_DIR}/extensions/pi-web-access/settings.json"
```

## What leaves the machine

Every outbound request goes through the code-side request guard
(`request-guard.ts`), which rejects non-http/https schemes and denies private
IP ranges. Only the following endpoints are contacted:

### Exa MCP (zero-config, no key)

- **Endpoint:** `https://mcp.exa.ai/mcp`
- **Method:** `POST`
- **Headers sent:**
  - `Content-Type: application/json`
  - `Accept: application/json, text/event-stream`
  - _No_ `Authorization` header
  - _No_ `User-Agent` header
  - _No_ `x-api-key` header
  - _No_ machine-identifying header of any kind
- **Request body** (JSON-RPC 2.0):
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "web_search_exa",
      "arguments": {
        "query": "<search query string>",
        "numResults": 5,
        "livecrawl": "fallback",
        "type": "auto",
        "contextMaxCharacters": 3000
      }
    }
  }
  ```
  `contextMaxCharacters` is `50000` when `includeContent: true`.
- **Machine-identifying info:** None. No machine ID, hostname, install ID, or
  user account information is sent. The query string itself is the only
  user-derived data in the payload.
- **Free-tier limit:** 1 000 requests/month. Local usage is tracked in
  `$PI_CODING_AGENT_DIR/cache/pi-web-access/exa-usage.json` and a warning is
  logged at 800 requests.

### Exa direct API (when `EXA_API_KEY` / `exaApiKey` is set)

- **Endpoint (simple queries):** `https://api.exa.ai/answer` — POST with `{ query, text: true }` body; authenticated via `x-api-key` header.
- **Endpoint (filtered/content queries):** `https://api.exa.ai/search` — POST with `{ query, type, numResults, includeDomains?, excludeDomains?, startPublishedDate?, contents }` body; authenticated via `x-api-key` header.
- **Machine-identifying info:** None beyond the API key used for authentication.

### Fetched URLs

`fetch_content` and the inline-content path of `web_search` perform plain HTTP/HTTPS
GET requests to whichever URLs you supply or that Exa returns as results. Those
requests carry a standard `fetch` User-Agent and no extra headers. Domain,
path, and query parameters of each URL leave the machine as part of the request.

## Request safety

All outbound HTTP calls go through the shared request guard in order:

1. **Scheme allowlist** — only `http:` and `https:` are permitted. `file:`,
   `data:`, `ftp:`, `javascript:`, `gopher:`, and all other schemes are
   rejected immediately.
2. **Host-deny list (DNS-rebinding resistant)** — enforced _after_ DNS
   resolution. Blocked ranges: loopback (127.0.0.0/8), RFC 1918
   (10/8, 172.16/12, 192.168/16), link-local / cloud metadata
   (169.254.0.0/16 including 169.254.169.254), CGNAT (100.64.0.0/10),
   unspecified (0.0.0.0/8), IPv6 ULA (fc00::/7), IPv6 loopback (::1), IPv6
   link-local (fe80::/10). Also blocks `*.internal`, `*.local`,
   `*.localhost`, and bare `localhost` by hostname suffix.
3. **Per-task fetch budget** — default 6 HTTP fetches per guard instance.
   Exceeded fetches throw `RequestBudgetExceeded`.
4. **Per-fetch body size cap** — default 5 MiB. Responses larger than this are
   streamed and aborted before the cap is reached, throwing `ResponseTooLarge`.

## License & attribution

- [LICENSE](LICENSE) — MIT. Original copyright © 2025 Nico Bailon; modification
  copyright © 2026 Diego Petrucci.
- [NOTICE](NOTICE) — pins the upstream repository URL, version, and commit SHA.
