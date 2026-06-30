# Publish checklist — v0.10.8

> Release-prep validation is complete; reviewer signoff, tagging, and publish steps remain pending.

## Release scope

- [x] publish the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-web-access@0.10.8`
- [x] document git tag `tlh-v0.10.8`
- [x] update install guidance to use the scoped package and pinned `0.10.8` install for tlh automation
- [x] add `0.10.8` changelog and release docs for the scoped npm release

## Preflight and release docs

- [x] verify `@diegopetrucci/pi-web-access@0.10.8` is not already published on npm
- [x] create release docs
  - [x] `docs/release-notes-v0.10.8.md`
  - [x] `docs/github-release-v0.10.8.md`
  - [x] `docs/publish-checklist-v0.10.8.md`
- [x] run local validation before any tag or publish step
  - completed after the package allowlist fix with the npm availability check, `npm test`, and `npm pack --dry-run --json`
- [ ] complete release-prep validation review before tagging or publishing

## Validation

- [x] npm registry availability check: `npm view @diegopetrucci/pi-web-access@0.10.8 version --json` → `E404 Not Found`, confirming the package is not yet published
- [x] `npm test` → passed (`2` tests, `0` failures)

```bash
npm view @diegopetrucci/pi-web-access@0.10.8 version --json
npm test
```

## Package dry-run

- [x] inspect the publish tarball metadata and included files
- [x] package dry-run inspected: `npm pack --dry-run --json` → `@diegopetrucci/pi-web-access@0.10.8` with `30` files

```bash
npm pack --dry-run --json
```

## Commit, tag, and GitHub release

- [ ] commit release changes on a non-main branch
- [ ] push the release branch
- [ ] open or update the PR targeting `main`
- [ ] after PR merge, tag `tlh-v0.10.8` on `main`
- [ ] push tag `tlh-v0.10.8`
- [ ] create the GitHub release for tag `tlh-v0.10.8` using `docs/github-release-v0.10.8.md`

## Stop before npm publish

> Human-only: npm publishing depends on the authenticated npm session.

- [ ] human publishes `@diegopetrucci/pi-web-access@0.10.8`

```bash
npm publish --access public
```

## Post-publish validation

- [ ] wait for npm propagation before validation (for example, 5 minutes after publish completes)
- [ ] verify the npm registry/package page shows `@diegopetrucci/pi-web-access@0.10.8`
- [ ] verify package metadata after propagation
- [ ] run an install check after propagation using the exact tlh pin

```bash
npm view @diegopetrucci/pi-web-access@0.10.8 name version dist.tarball --json
pi install npm:@diegopetrucci/pi-web-access@0.10.8
```
