# Security

## Scope

`@diegopetrucci/pi-web-access@0.29.2` is a The Last Harness selective port with exactly three tools: `web_search`, `fetch_content`, and `get_search_content`. It is based on upstream `nicobailon/pi-web-access@192ac18`, not a claim of upstream v0.29.0 feature parity.

All tool use requires `PI_CODING_AGENT_DIR` to be an absolute path. The only package settings path is:

```text
$PI_CODING_AGENT_DIR/extensions/pi-web-access/settings.json
```

The only supported settings are `exaApiKey`, `fetch.timeout` (1–120 seconds, default 30), `fetchContent.domainPolicy` (`allow`/`deny` hostname lists), and `maxInlineContentChars` (512–30,000, default 12,000). A non-empty isolated `exaApiKey` takes precedence over `EXA_API_KEY`; with neither, search uses unauthenticated Exa MCP. No proxy or environment-proxy settings are supported.

## Runtime security requirements

Use stable Node.js 22.23.4+ within 22.x, 24.22.1+ within 24.x, or 26.12.1+ within 26.x. Other branches and prereleases are unsupported. Registration and the shared remote-request boundary reject unsupported runtimes, including when a custom fetch implementation is supplied.

These floors include the [October 2026 Node security fixes](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases), including CVE-2026-111497 in the native Brotli decoder and the [eMudhra CA update](https://emudhra.we-have-a-problem.com/). A permitted public server can return a Brotli response; SSRF checks, output limits, an npm dependency update, and `Accept-Encoding: identity` cannot replace a patched Node runtime. Undici must also be at least 8.12.2 for its separate TLS and response-handling fixes.

Operators must upgrade the actual Node executable hosting Pi, then restart that process under the fixed runtime. Updating this package does not upgrade an already running host. System/OpenSSL CA stores, `NODE_EXTRA_CA_CERTS`, custom CA bundles, and custom transports require independent trust-store remediation; the version check cannot validate their contents. Keep certificate verification enabled. No host upgrades or restarts are performed by this package.

## Request protections

- Only HTTP(S) requests are allowed. Internal, loopback, private, reserved, and blocked local hostnames are rejected.
- DNS is checked before transport and again at connection time; the checked public address is pinned.
- Redirects are manual, limited to five hops, and revalidated per hop. Cross-origin redirects strip `Authorization` and `x-api-key`.
- A six-operation budget resets at each `agent_start`. Responses are capped at 5 MiB and extracted output at 1,000,000 characters.
- Fetch cache data is local at `$PI_CODING_AGENT_DIR/cache/pi-web-access`, expires after one hour, and is limited to 128 entries/128 MiB with 0700/0600 directory/file permissions.
- API keys are redacted from diagnostics. Search data goes to Exa; requested pages go to their origins. Extraction is local and there are no hidden model calls, hosted extraction services, browser-cookie flows, or telemetry.

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` are intentionally ignored. Do not assume a proxy, custom provider endpoint, or local-network target is available.

## Reporting

Do not disclose credentials, private URLs, or personal data in a public issue. Report a suspected vulnerability through the repository's private GitHub security reporting channel when available, or contact the maintainers privately with a minimal reproduction, affected version, and impact. Allow time for a fix before public disclosure.

To remove the package and its package-owned data, uninstall version `0.29.2` from the host runtime and remove the settings file plus `$PI_CODING_AGENT_DIR/cache/pi-web-access/`. The external tlh pin and obsolete curator/search documentation are intentionally a separate post-publication follow-up and are not changed by this repository release.
