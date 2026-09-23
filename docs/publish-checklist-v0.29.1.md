# Publish checklist — v0.29.1

## Release scope

- [ ] confirm this is the selective Exa-only security/token-efficiency port through upstream `192ac18`, not upstream v0.29.0 feature parity
- [ ] confirm package version `0.29.1` and intended tag `tlh-v0.29.1`
- [ ] confirm the external tlh repository and pin are unchanged

## Local checks

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `npm run package:check`
- [ ] `npm pack --dry-run --json` and inspect the exact allowlist
- [ ] `git diff --check`
- [ ] verify no files are staged

The tarball must contain exactly `package.json`, these runtime files:
`activity.ts`, `data-uri-sanitize.ts`, `exa.ts`, `extract.ts`, `index.ts`,
`request-budget.ts`, `rsc-extract.ts`, `settings.ts`,
`ssrf-protection.ts`, `storage.ts`, `web-tools.ts`, and these release files:
`README.md`, `CHANGELOG.md`, `SECURITY.md`, `NOTICE`, `LICENSE`.

## Trusted-publishing handoff

- [ ] merge the reviewed release changes
- [ ] create and push `tlh-v0.29.1`
- [ ] dispatch **Release to npm** with `ref=tlh-v0.29.1`
- [ ] confirm `npm ci`, tests, typecheck, package-shape assertions, and unpublished-version preflight pass
- [ ] confirm the workflow publishes with `npm publish --access public --provenance`

Do not run a human-shell publish unless trusted publishing is unavailable; record
the reason if the fallback is required.

## Post-publication

- [ ] verify `@diegopetrucci/pi-web-access@0.29.1` after npm propagation
- [ ] verify the exact pinned install target
- [ ] in a separate authorized change, update the external tlh package pin to `0.29.1`
- [ ] in that same separate follow-up, remove or correct obsolete external curator/search docs
