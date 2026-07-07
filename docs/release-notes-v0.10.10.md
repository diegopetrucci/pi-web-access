# Release notes — v0.10.10

## Highlights

This patch release ships the TLH web-search config isolation fix on `main`, ensuring config and Exa usage storage resolve through The Last Harness isolated profile before falling back to standard Pi locations. It prepares the tlh-maintained fork for the scoped npm package `@diegopetrucci/pi-web-access@0.10.10`, documents the GitHub release/tag handoff for `tlh-v0.10.10`, and keeps the install guidance pinned for tlh automation.

## pi-web-access

- resolves web-search config paths from `PI_CODING_AGENT_DIR`, then `XDG_CONFIG_HOME/pi`, then `~/.pi`
- applies the same isolation behavior to Exa usage storage
- prevents tlh isolated profiles from reading or writing normal upstream Pi profile config
- updates runtime guidance, docs, and config-path tests for the isolated-profile behavior
- prepares this fork for npm as `@diegopetrucci/pi-web-access@0.10.10` with public package metadata and pinned-install guidance for tlh automation
- prepares the release handoff for git tag `tlh-v0.10.10`
- includes release notes, GitHub release copy, and a publish checklist with a human-only npm publish stop and post-publish validation steps

## Packaging

- scoped package: `@diegopetrucci/pi-web-access@0.10.10`
- git tag: `tlh-v0.10.10`
- publish access: `public`
- repository: `https://github.com/diegopetrucci/pi-web-access`

## Install

```bash
pi install npm:@diegopetrucci/pi-web-access@0.10.10
```

Then reload Pi:

```text
/reload
```

## Validation status

- release-prep validation completed locally and is recorded in `docs/publish-checklist-v0.10.10.md`
- npm availability check returned the expected `E404` / unpublished result for `@diegopetrucci/pi-web-access@0.10.10`
- `npm test` passed (`11` passed, `0` failed)
- `npm pack --dry-run --json` produced package metadata for `@diegopetrucci/pi-web-access@0.10.10` with `30` files
- reviewer signoff, PR/merge/tag, npm publish, and post-publish validation remain pending
