# Releasing

This is the evergreen release procedure for the The Last Harness (tlh) fork and
`@diegopetrucci/pi-web-access`. The npm package is a selective Exa-only port;
its release tag is `tlh-v0.29.1` for this handoff.

## Trusted publishing

Use the **Release to npm** workflow (`.github/workflows/release.yml`) through
GitHub Actions `workflow_dispatch`:

1. Merge the release changes and create/push the release tag, normally
   `tlh-v<version>`.
2. Dispatch **Release to npm** with the required `ref=<release tag>` input.
   The workflow requires the exact `tlh-v<package-version>` value and rejects
   branches, `main`, and mismatched tags.
3. The workflow checks out the tag, uses Node 24, runs `npm ci`, `npm test`,
   `npm run typecheck`, `npm run audit:runtime`, and `npm run package:check`,
   then fails if the exact `name@version` is already on npm.
4. On success it runs `npm publish --access public --provenance`.

The workflow keeps `contents: read` and `id-token: write` only. npm trusted
publishing must be configured for package
`@diegopetrucci/pi-web-access`, repository
`diegopetrucci/pi-web-access`, workflow `release.yml`. No npm token belongs in
repository secrets.

`package:check` runs an npm dry-run and asserts the exact package file set:
`package.json`, the required runtime TypeScript files, `README.md`,
`CHANGELOG.md`, `SECURITY.md`, `NOTICE`, and `LICENSE`. Tests, docs, skills,
media, `.gnosis`, `.tickets`, lockfiles, and release artifacts must remain out
of the tarball.

## Human fallback

A shell `npm publish` is not the default. Use it only when trusted publishing
is unavailable, record the reason in the release handoff, and preserve
`--access public --provenance` where the local npm version supports provenance.

## Post-publication follow-up

After npm propagation, verify the package and the exact install target. Then,
in a separately authorized change to the external tlh repository, update its
pin to `@diegopetrucci/pi-web-access@0.29.1` and remove or correct obsolete
curator/search documentation. This repository release does not edit that
external repository or pin.
