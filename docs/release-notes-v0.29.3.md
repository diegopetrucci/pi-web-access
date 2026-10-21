# Release notes — v0.29.3

## Summary

`@diegopetrucci/pi-web-access@0.29.3` is a The Last Harness (tlh) security
patch release. It packages the already-landed patched-Node runtime policy and
Undici fixes from `b77b4d5`; this release preparation adds no runtime features,
tools, or dependency changes beyond those fixes.

## Security floors

- Supported stable Node.js release lines are **22.23.4+ within 22.x,
  24.22.1+ within 24.x, and 26.12.1+ within 26.x**. Other release lines and
  prereleases are unsupported. Extension registration and the shared remote
  request boundary reject unsupported runtimes.
- These floors include the October 2026 Node security fixes, including the
  native Brotli decoder fix (CVE-2026-111497) and the eMudhra CA update. The
  actual Node executable hosting the compatible upstream Pi coding-agent
  runtime must be upgraded and restarted; installing this package does not
  upgrade an already-running host.
- The direct Undici dependency floor is `8.12.2`, and the lockfile resolves
  `8.12.3` for its separate TLS and response-handling security fixes.

## Unchanged tool and security scope

The package still registers exactly three tools: `web_search`,
`fetch_content`, and `get_search_content`. It remains an Exa-only search and
bounded local URL-extraction port requiring an absolute `PI_CODING_AGENT_DIR`;
it does not add upstream provider, media, repository, browser-cookie, curator,
or summary workflows.

The existing security boundaries remain unchanged: local extraction, SSRF and
redirect protections, bounded responses and storage, API-key redaction, and
the six-operation request budget. This release does not widen the runtime
policy or alter the dependency graph beyond the already-landed Node and
Undici fixes.

## Install and trusted publishing

The exact install target for the compatible upstream Pi coding-agent runtime
is:

```bash
pi install npm:@diegopetrucci/pi-web-access@0.29.3
```

The intended Git tag is `tlh-v0.29.3`. Publication uses the existing GitHub
Actions **Release to npm** trusted-publishing workflow, dispatched with
`ref=tlh-v0.29.3`. It checks the tag and package-version match, runs the
release checks, and publishes with `npm publish --access public --provenance`.

## Rollback and external scope

npm package versions are immutable: a published `0.29.3` cannot be overwritten.
If an operational rollback is unavoidable, pin the host to an older published
version such as `@diegopetrucci/pi-web-access@0.29.2`; older versions do **not**
provide these Node and Undici security fixes, so that rollback is not a
security-equivalent remedy. Use a separately authorized fixed release for the
forward path.

The external tlh repository, its package pin, user configuration, and obsolete
curator/search documentation are explicitly out of scope for this repository
release. Any external pin or documentation update requires a separate
authorization and follow-up.
