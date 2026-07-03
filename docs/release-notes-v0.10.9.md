# Release notes — v0.10.9

## Highlights

This patch release ships the already-landed lazy-load startup improvement on `main`, deferring startup-heavy web access paths until first use to reduce extension bootstrap cost while preserving existing behavior. It also prepares the tlh-maintained fork for the scoped npm package `@diegopetrucci/pi-web-access@0.10.9`, documents the GitHub release/tag handoff for `tlh-v0.10.9`, and keeps the install guidance pinned for tlh automation.

## pi-web-access

- ships the lazy-load startup-heavy web access paths improvement already on `main`, deferring search, extraction, code search, curator, summary-review, and Gemini Web/browser-cookie modules until first use
- prepares this fork for npm as `@diegopetrucci/pi-web-access@0.10.9` with public package metadata and pinned-install guidance for tlh automation
- prepares the release handoff for git tag `tlh-v0.10.9`
- includes release notes, GitHub release copy, and a publish checklist with a human-only npm publish stop and post-publish validation steps

## Packaging

- scoped package: `@diegopetrucci/pi-web-access@0.10.9`
- git tag: `tlh-v0.10.9`
- publish access: `public`
- repository: `https://github.com/diegopetrucci/pi-web-access`

## Install

```bash
pi install npm:@diegopetrucci/pi-web-access@0.10.9
```

Then reload Pi:

```text
/reload
```

## Validation status

- release-prep validation completed for `pwa-405u` and is recorded in `docs/publish-checklist-v0.10.9.md`
- npm availability check returned the expected `E404` / unpublished result for `@diegopetrucci/pi-web-access@0.10.9`
- `npm test` passed (`8` passed, `0` failed)
- `npm pack --dry-run --json` produced package metadata for `@diegopetrucci/pi-web-access@0.10.9` with `30` files
- reviewer signoff, PR/merge/tag, npm publish, and post-publish validation remain pending
