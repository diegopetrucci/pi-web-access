# Release notes — v0.29.2

## Summary

`@diegopetrucci/pi-web-access@0.29.2` is a The Last Harness (tlh)
selective maintenance release containing six upstream fixes integrated by this
fork's [PR #19](https://github.com/diegopetrucci/pi-web-access/pull/19). It is
**not** a claim of upstream v0.29.0 feature parity.

### Six approved maintenance ports

- `fetch_content` rejects HTTP 200 Cloudflare challenge pages instead of
  returning interstitial content, while preserving ordinary non-challenge
  HTML handling.
- `get_search_content` defaults to the sole stored fetched URL when no URL
  selector is supplied; multiple stored URLs still require an explicit
  selector.
- `web_search` prepares JSON-string `queries` and `domainFilter` arrays before
  schema validation without changing ordinary inputs.
- Untitled Exa results use bounded URL hostnames as source labels, retaining
  existing titles and generic fallbacks for malformed or hostless URLs.
- The direct `undici` dependency requires 8.11.2 or newer.
- `typebox` is a host-provided peer (`*`) with an exact 1.3.27 development pin,
  avoiding a duplicate private runtime copy.

## Unchanged boundaries and advisory

The release keeps the existing selective boundaries: exactly three tools
(`web_search`, `fetch_content`, and `get_search_content`), Exa-only search,
local URL extraction, and the required absolute `PI_CODING_AGENT_DIR`. It does
not add upstream providers, media, repository, browser-cookie, curator, or
summary workflows.

The existing security and token-efficiency boundaries also remain in place,
including local extraction, SSRF and redirect protections, bounded responses
and storage, and the six-operation request budget. A known pre-existing high
severity `brace-expansion` advisory remains in the development-only dependency
tree; `npm audit --omit=dev` reports zero runtime findings. This release does
not upgrade dependencies to change that advisory.

## Install and trusted-publishing handoff

The intended Git tag is `tlh-v0.29.2`. Install it in the compatible upstream
Pi coding-agent runtime with the exact target:

```bash
pi install npm:@diegopetrucci/pi-web-access@0.29.2
```

Publication uses the existing GitHub Actions **Release to npm** trusted-
publishing workflow. The workflow is dispatched with `ref=tlh-v0.29.2`, checks
the matching checked-out tag and package version, runs the release validation,
and publishes with npm provenance. The external tlh repository pin and config
remain unchanged.

## Rollback

If a rollback is needed, pin the compatible host runtime to
`@diegopetrucci/pi-web-access@0.29.1`. npm versions are immutable: do not
overwrite the published `0.29.2` version; use the older pinned version until a
separately authorized release is available.
