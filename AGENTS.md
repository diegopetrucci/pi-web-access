# AGENTS

## Repository role

- This repository is the `pi-web-access` fork maintained for **The Last Harness (tlh)**: https://github.com/diegopetrucci/the-last-harness
- Fork origin: `diegopetrucci/pi-web-access`
- Upstream source of truth: `nicobailon/pi-web-access`
- Purpose: maintain a reviewable fork of the web access extension while preserving upstream compatibility unless an approved fork delta is required.

## Fork sync policy

- Keep this fork close to upstream `nicobailon/pi-web-access`.
- Prefer small, auditable diffs that are easy to rebase or replay during upstream sync.
- Treat upstream behavior, public tool contracts, config semantics, and user-visible workflows as the default.
- Add TLH-specific behavior only when required for compatibility, release/distribution, safety, or clearly approved fork needs.
- Avoid speculative refactors while the fork carries local deltas.

## Important TLH / pi-web-access hotspots

- **Extension bootstrap, tool contracts, and config writes**: `index.ts`, `storage.ts`, `activity.ts`
  - Changes here can break registered tools, response persistence, session restore behavior, or writes to `~/.pi/web-search.json`.
- **Search provider selection and fallback order**: `gemini-search.ts`, `exa.ts`, `perplexity.ts`, `gemini-api.ts`, `gemini-web.ts`, `gemini-web-config.ts`, `code-search.ts`
  - Preserve the documented provider order, config parsing, and zero-config Exa/Gemini fallback behavior unless an approved ticket says otherwise.
- **Content extraction routing**: `extract.ts`, `github-extract.ts`, `pdf-extract.ts`, `rsc-extract.ts`
  - Changes here can break URL-type detection, GitHub clone behavior, PDF/export handling, blocked-page recovery, or extraction concurrency/timeouts.
- **Video and browser-cookie flows**: `youtube-extract.ts`, `video-extract.ts`, `chrome-cookies.ts`
  - Preserve current YouTube/local-video analysis behavior, frame extraction semantics, and browser-cookie safety expectations.
- **Curator and summary-review UX**: `curator-server.ts`, `curator-page.ts`, `summary-review.ts`
  - Keep summary-review defaults, timeout behavior, and curator submission flows aligned with upstream unless the approved work explicitly changes them.

## Development commands

- Validation command: `npm test`

## Releases

- npm publishing goes through GitHub Actions trusted publishing; see `docs/RELEASING.md`.

## Gnosis / memory

- Commit `.gnosis/entries.jsonl` changes created or updated during repo work with the related work by default, unless the user explicitly says otherwise.
- Preserve existing `.gnosis/entries.jsonl` entries unless the assigned work explicitly requires changing them.

## Working rules

- Prefer the smallest correct change.
- Preserve upstream-compatible tool names, parameter semantics, fallback order, and user-facing workflows unless an approved ticket says otherwise.
- Keep user-owned configuration, downloaded artifacts, and cached clone behavior stable unless the task explicitly changes them.
- Update docs/tests together with behavior changes when they materially reduce fork risk.
- For docs-only work, inspect `git status` and `git diff`; run `npm test` when runtime behavior is touched or when confidence requires it.
