# The Last Harness Web Access

`@diegopetrucci/pi-web-access@0.29.1` is a **The Last Harness (tlh)** selective fork for the compatible upstream Pi coding-agent runtime. It is a security and token-efficiency port based on upstream `nicobailon/pi-web-access@192ac18` (the upstream v0.29.0 release-preparation commit). It is **not** feature parity with upstream v0.29.0.

Only Exa search and bounded local URL extraction are included. The package registers exactly three tools, requires an isolated `PI_CODING_AGENT_DIR`, and does not provide the broader upstream provider, media, repository, browser-cookie, curator, or summary workflows.

## Install

In the compatible upstream Pi coding-agent runtime:

```bash
pi install npm:@diegopetrucci/pi-web-access@0.29.1
```

Requires Node.js **>=22.19.0**. Set an absolute profile path before using any tool:

```bash
export PI_CODING_AGENT_DIR=/absolute/path/to/tlh-profile
```

The variable is mandatory. There is no fallback to `~/.pi`, `XDG_CONFIG_HOME`, or a legacy profile path.

## Tools

### `web_search`

Searches Exa and returns bounded source titles and URLs. Provider snippets are stored for explicit `get_search_content` retrieval when a response ID is provided. It accepts one `query` or up to four `queries`, returns 1–10 results per query (default 5), and supports `recencyFilter` (`day`, `week`, `month`, or `year`) and hostname `domainFilter`. Search output is capped at 16,000 characters. It never performs automatic page fetching or hidden model calls.

### `fetch_content`

Fetches up to six `http://` or `https://` URLs and extracts readable Markdown locally. It supports only the `url` and `urls` parameters. Git repositories, PDFs, images, audio/video, local files, browser cookies, and hosted extraction services are not special-cased or included.

### `get_search_content`

Retrieves stored search or fetch material using a `responseId` and a query/URL selector. It supports bounded, line-aware continuation with `offset` and `limit`, or one case-insensitive literal `findText` match. A response ID is exposed only when stored material was omitted or truncated from the preceding tool result.

## Isolated settings and cache

The only supported settings file is:

```text
$PI_CODING_AGENT_DIR/extensions/pi-web-access/settings.json
```

The only supported fetched-content cache is:

```text
$PI_CODING_AGENT_DIR/cache/pi-web-access/
```

The settings file is optional; the absolute `PI_CODING_AGENT_DIR` is not. Settings are read for each request. Supported settings are exactly:

```json
{
  "exaApiKey": "exa-...",
  "fetch": {
    "timeout": 30
  },
  "fetchContent": {
    "domainPolicy": {
      "allow": ["docs.example.com"],
      "deny": ["private.example.com"]
    }
  },
  "maxInlineContentChars": 12000
}
```

- `exaApiKey` is a non-empty Exa API key. Precedence is isolated `exaApiKey`, then `EXA_API_KEY`, then keyless Exa MCP. An empty setting falls through to the environment; invalid values fail closed.
- `fetch.timeout` is an integer number of seconds from 1 through 120; the default is 30. It is the outbound request and extraction timeout.
- `fetchContent.domainPolicy` contains optional hostname arrays `allow` and `deny`. An `allow` list restricts fetches to matching domains; `deny` wins, and subdomains match. Wildcards are not accepted. This policy applies to `fetch_content`, not Exa's fixed provider endpoints.
- `maxInlineContentChars` is an integer from 512 through 30,000; the default is 12,000. It bounds inline fetch and retrieval pages.

No other configuration keys, custom provider endpoints, credential commands, or proxy settings are supported.

## Provider and network behavior

With a key, `web_search` sends bounded search requests to Exa's fixed `https://api.exa.ai/search` endpoint. Without a key, it sends JSON-RPC search requests to `https://mcp.exa.ai/mcp` without credentials. Keyless MCP still requires outbound network access; it is not an offline mode. The implementation does not use Exa `/answer`, other providers, automatic content retrieval, or local usage accounting.

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` are not interpreted. There is no proxy or environment-proxy support. Requests use direct transport through the package's guarded HTTP path.

## Privacy and security limits

- Search queries and filters go to Exa; a configured API key is sent only to Exa's API endpoint. Keyless requests contain no Exa API key.
- Requested page URLs go to their origins. Page extraction and Defuddle fallback run locally; this package sends no page to an LLM or hosted extraction service and has no telemetry or hidden model turn.
- API keys are not included in tool output or diagnostics. Fetched content is kept in memory and in the local cache, not uploaded by the package.
- Remote requests allow only HTTP(S), reject credentials in URLs, block loopback/private/reserved addresses and local hostname suffixes, resolve DNS before connecting, and pin the checked public address at connection time.
- Redirects are manual, limited to five hops, and revalidated on every hop. `Authorization` and `x-api-key` headers are removed on cross-origin redirects.
- A shared budget permits six provider/page operations per agent run and resets at `agent_start`. Each response is capped at 5 MiB; extraction output is capped at 1,000,000 characters; search output is capped at 16,000 characters.
- Fetched-content cache entries expire after one hour and are limited to 128 entries and 128 MiB aggregate. The cache directory is mode 0700 and cache files are mode 0600.

## Removed workflows

This release does not register or ship `code_search`, `source_check`, aliases, curator or `/websearch` flows, summary-review/result-review workflows, background `includeContent` fetching, provider fallbacks, GitHub/PDF/video workflows, browser-cookie access, bundled research skills, or media assets. The only registered tools are the three listed above.

## Remove or undo

To undo the installation, remove `@diegopetrucci/pi-web-access@0.29.1` from the compatible host runtime using its package manager. Then remove only the package-owned profile data if it is no longer needed:

```bash
rm -f "$PI_CODING_AGENT_DIR/extensions/pi-web-access/settings.json"
rm -rf "$PI_CODING_AGENT_DIR/cache/pi-web-access"
```

Unset `PI_CODING_AGENT_DIR` or remove the extension through the host runtime if the profile should no longer load it. These steps do not alter any external service or shared profile data outside the two package-owned paths.

## Release handoff

The intended tag is `tlh-v0.29.1`. This repository does not change the external tlh repository, its package pin, or its obsolete curator/search documentation. After publication, update that external repository in a separately authorized follow-up to pin `@diegopetrucci/pi-web-access@0.29.1` and remove or correct those obsolete docs.

See [`SECURITY.md`](SECURITY.md) for reporting guidance and the [repository release procedure](https://github.com/diegopetrucci/pi-web-access/blob/main/docs/RELEASING.md) for the trusted-publishing handoff.
