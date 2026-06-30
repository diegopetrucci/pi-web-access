# Release notes — v0.10.8

## Highlights

This release prepares the tlh-maintained fork for the scoped npm package `@diegopetrucci/pi-web-access@0.10.8`, documents the GitHub release/tag handoff for `tlh-v0.10.8`, and keeps the install guidance pinned for tlh automation.

## pi-web-access

- prepares this fork for npm as `@diegopetrucci/pi-web-access@0.10.8` with public package metadata and pinned-install guidance for tlh automation
- prepares the release handoff for git tag `tlh-v0.10.8`
- includes release notes, GitHub release copy, and a publish checklist with a human-only npm publish stop and post-publish validation steps

## Packaging

- scoped package: `@diegopetrucci/pi-web-access@0.10.8`
- git tag: `tlh-v0.10.8`
- publish access: `public`
- repository: `https://github.com/diegopetrucci/pi-web-access`

## Install

```bash
pi install npm:@diegopetrucci/pi-web-access@0.10.8
```

Then reload Pi:

```text
/reload
```

## Validation status

- release-prep validation is complete and remains tracked in `docs/publish-checklist-v0.10.8.md`
- npm registry availability check for `@diegopetrucci/pi-web-access@0.10.8` returned the expected `E404` before first publish
- local `npm test` passed
- `npm pack --dry-run --json` produced `@diegopetrucci/pi-web-access@0.10.8` with 30 files
- reviewer signoff, PR/merge/tag, npm publish, and post-publish validation remain pending
