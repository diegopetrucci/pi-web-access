Prepares the tlh-maintained fork for the scoped npm package `@diegopetrucci/pi-web-access@0.10.9` and the tlh release tag `tlh-v0.10.9`.

## Highlights

- Scoped npm release: `@diegopetrucci/pi-web-access@0.10.9`
- Git tag: `tlh-v0.10.9`
- Exact install pin for tlh automation: `pi install npm:@diegopetrucci/pi-web-access@0.10.9`
- Ships the already-landed lazy-load startup improvement that defers startup-heavy web access paths until first use
- Release-prep validation completed for `pwa-405u`: npm availability returned expected `E404` / unpublished, `npm test` passed (`8`/`0`), and `npm pack --dry-run --json` produced `@diegopetrucci/pi-web-access@0.10.9` with `30` files; reviewer signoff, PR/merge/tag, npm publish, and post-publish verification remain pending in `docs/publish-checklist-v0.10.9.md`

## Install

```bash
pi install npm:@diegopetrucci/pi-web-access@0.10.9
```

Then reload Pi:

```text
/reload
```

## Validation and publish handoff

- Release-prep validation has been run and recorded in `docs/publish-checklist-v0.10.9.md`: expected npm `E404` / unpublished for `@diegopetrucci/pi-web-access@0.10.9`, `npm test` passed (`8`/`0`), and `npm pack --dry-run --json` produced `@diegopetrucci/pi-web-access@0.10.9` with `30` files
- Reviewer signoff, PR/merge/tag with `tlh-v0.10.9`, the human-only npm publish stop, public npm publish, and post-publish validation after npm propagation remain pending
