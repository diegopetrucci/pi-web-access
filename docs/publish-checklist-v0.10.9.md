# Publish checklist — v0.10.9

> Release-prep validation was run for `pwa-405u`; reviewer signoff, PR/merge/tag/GitHub release, human npm publish, and post-publish validation all remain pending.

## Release scope

- [x] publish the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-web-access@0.10.9`
- [x] document git tag `tlh-v0.10.9`
- [x] update install guidance to use the scoped package and pinned `0.10.9` install for tlh automation
- [x] add `0.10.9` changelog and release docs for the lazy-load startup-heavy web access paths release

## Preflight and release docs

- [x] verify `@diegopetrucci/pi-web-access@0.10.9` is not already published on npm
- [x] create release docs
  - [x] `docs/release-notes-v0.10.9.md`
  - [x] `docs/github-release-v0.10.9.md`
  - [x] `docs/publish-checklist-v0.10.9.md`
- [x] run local validation before any tag or publish step
  - completed in `pwa-405u`; see validation results below
- [ ] complete release-prep validation review before tagging or publishing

## Validation

- [x] npm registry availability check: `npm view @diegopetrucci/pi-web-access@0.10.9 version --json`
- [x] `npm test`
- [x] inspect package dry-run metadata after validation: `npm pack --dry-run --json`

```bash
npm view @diegopetrucci/pi-web-access@0.10.9 version --json
npm test
npm pack --dry-run --json
```

### Validation results recorded by `pwa-405u`

- `npm view @diegopetrucci/pi-web-access@0.10.9 version --json`
  - result: expected `E404` (`No match found for version 0.10.9`), confirming the scoped package/version is not yet published
- `npm test`
  - result: passed (`8` tests passed, `0` failed)
- `npm pack --dry-run --json`
  - package metadata: name `@diegopetrucci/pi-web-access`, version `0.10.9`, tarball `diegopetrucci-pi-web-access-0.10.9.tgz`
  - package contents: `30` files (`entryCount: 30`)
  - spot check: package includes expected root sources/docs/assets such as `index.ts`, `package.json`, `README.md`, `CHANGELOG.md`, `banner.png`, `pi-web-fetch-demo.mp4`, and `skills/librarian/SKILL.md`; no generated tarball was written because the run used `--dry-run`

## Commit, tag, and GitHub release

- [ ] commit release changes on a non-main branch
- [ ] push the release branch
- [ ] open or update the PR targeting `main`
- [ ] after PR merge, tag `tlh-v0.10.9` on `main`
- [ ] push tag `tlh-v0.10.9`
- [ ] create the GitHub release for tag `tlh-v0.10.9` using `docs/github-release-v0.10.9.md`

## Stop before npm publish

> Human-only: npm publishing depends on the authenticated npm session.

- [ ] human publishes `@diegopetrucci/pi-web-access@0.10.9`

```bash
npm publish --access public
```

## Post-publish validation

- [ ] wait for npm propagation before validation (for example, 5 minutes after publish completes)
- [ ] verify the npm registry/package page shows `@diegopetrucci/pi-web-access@0.10.9`
- [ ] verify package metadata after propagation
- [ ] run an install check after propagation using the exact tlh pin

```bash
npm view @diegopetrucci/pi-web-access@0.10.9 name version dist.tarball --json
pi install npm:@diegopetrucci/pi-web-access@0.10.9
```
