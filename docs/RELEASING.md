# Releasing

This is the evergreen release doc for the `pi-web-access` fork maintained for
The Last Harness (tlh). It describes the default way to publish
`@diegopetrucci/pi-web-access` to npm.

## Default: GitHub Actions trusted publishing

The default publish path is the **Release to npm** workflow
(`.github/workflows/release.yml`), dispatched manually from GitHub Actions:

1. Trigger the workflow via `workflow_dispatch`.
2. Provide the workflow input `ref` (the release tag, e.g. `tlh-v0.10.11`).
   `ref` defaults to `main` if left blank, but releases should always pass the
   actual release tag.
3. The workflow checks out that ref, sets up Node 20, and runs a preflight
   step that fails the run if `package.json`'s `name@version` is already
   published on npm.
4. If preflight passes, the workflow publishes with
   `npm publish --access public --provenance`, using npm trusted publishing
   (OIDC) — no npm token is stored in this repo or in CI secrets.

This requires the trusted publisher to be configured on npmjs.com for
`@diegopetrucci/pi-web-access`, pointing at repo
`diegopetrucci/pi-web-access` and workflow `release.yml`.

## Fallback: human-shell `npm publish`

Running `npm publish` from a human shell session is **not** the default
anymore. Keep it only as an explicit, called-out fallback for when CI trusted
publishing is unavailable (e.g. the workflow itself is broken or npm's OIDC
publishing is down). If you use the fallback, say so explicitly in the
release checklist and record why CI wasn't used.

## Guidance for future publish checklists

Per-release publish checklists (`docs/publish-checklist-v*.md`) should
include a **"Trusted publishing handoff"** section instead of the older
"Stop before npm publish" human-only section. That section should:

- Note that publishing happens via the existing trusted publishing workflow
  in `.github/workflows/release.yml`, and that `npm publish` should not be
  run from a human shell session.
- Include a checklist item to run the GitHub Actions workflow **Release to
  npm**.
- Include a checklist item recording the workflow input used, e.g.
  `ref=<release tag>`.
- Include a checklist item confirming the workflow preflight reports the
  version is not already published.
- Include a checklist item confirming the workflow completes
  `npm publish --access public --provenance`.

See `diegopetrucci/pi-mcp-adapter`'s `docs/publish-checklist-v2.10.2.md` (at
commit `f82b0a5`) for an example of this section's wording.
