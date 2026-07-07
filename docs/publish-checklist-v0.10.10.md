# Publish checklist — v0.10.10

> Release-prep validation was run locally; reviewer signoff, PR/merge/tag/GitHub release, human npm publish, and post-publish validation all remain pending.

## Release scope

- [x] publish the tlh-maintained fork as the scoped npm package `@diegopetrucci/pi-web-access@0.10.10`
- [x] document git tag `tlh-v0.10.10`
- [x] update install guidance to use the scoped package and pinned `0.10.10` install for tlh automation
- [x] add `0.10.10` changelog and release docs for the TLH web-search config isolation fix

## Preflight and release docs

- [x] verify `@diegopetrucci/pi-web-access@0.10.10` is not already published on npm
- [x] create release docs
  - [x] `docs/release-notes-v0.10.10.md`
  - [x] `docs/github-release-v0.10.10.md`
  - [x] `docs/publish-checklist-v0.10.10.md`
- [x] run local validation before any tag or publish step
  - see validation results below
- [ ] complete release-prep validation review before tagging or publishing

## Validation

- [x] npm registry availability check: `npm view @diegopetrucci/pi-web-access@0.10.10 version --json`
- [x] `npm test`
- [x] inspect package dry-run metadata after validation: `npm pack --dry-run --json`

```bash
npm view @diegopetrucci/pi-web-access@0.10.10 version --json
npm test
npm pack --dry-run --json
```

### Validation results

- `npm view @diegopetrucci/pi-web-access@0.10.10 version --json`
  - result: expected `E404` (`No match found for version 0.10.10`), confirming the scoped package/version is not yet published
- `npm test`
  - result: passed (`11` tests passed, `0` failed)
- `npm pack --dry-run --json`
  - package metadata: name `@diegopetrucci/pi-web-access`, version `0.10.10`, tarball `diegopetrucci-pi-web-access-0.10.10.tgz`
  - package contents: `30` files (`entryCount: 30`)
  - spot check: package includes expected root sources/docs/assets such as `index.ts`, `package.json`, `README.md`, `CHANGELOG.md`, `banner.png`, `pi-web-fetch-demo.mp4`, and `skills/librarian/SKILL.md`; no generated tarball was written because the run used `--dry-run`

## Commit, tag, and GitHub release

- [ ] commit release changes on a non-main branch
- [ ] push the release branch
- [ ] open or update the PR targeting `main`
- [ ] after PR merge, tag `tlh-v0.10.10` on `main`
- [ ] push tag `tlh-v0.10.10`
- [ ] create the GitHub release for tag `tlh-v0.10.10` using `docs/github-release-v0.10.10.md`

## Stop before npm publish

> Human-only: npm publishing depends on the authenticated npm session.

- [ ] human publishes `@diegopetrucci/pi-web-access@0.10.10`

```bash
npm publish --access public
```

## Post-publish validation

- [ ] wait for npm propagation before validation (for example, 5 minutes after publish completes)
- [ ] verify the npm registry/package page shows `@diegopetrucci/pi-web-access@0.10.10`
- [ ] verify package metadata after propagation
- [ ] run an install check after propagation using the exact tlh pin

```bash
npm view @diegopetrucci/pi-web-access@0.10.10 name version dist.tarball --json
pi install npm:@diegopetrucci/pi-web-access@0.10.10
```
