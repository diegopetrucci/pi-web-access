Prepares the tlh-maintained fork for the scoped npm package `@diegopetrucci/pi-web-access@0.10.8` and the tlh release tag `tlh-v0.10.8`.

## Highlights

- Scoped npm release: `@diegopetrucci/pi-web-access@0.10.8`
- Git tag: `tlh-v0.10.8`
- Exact install pin for tlh automation: `pi install npm:@diegopetrucci/pi-web-access@0.10.8`
- Release-prep validation is complete; reviewer signoff, PR/merge/tag, npm publish, and post-publish verification remain pending in `docs/publish-checklist-v0.10.8.md`

## Install

```bash
pi install npm:@diegopetrucci/pi-web-access@0.10.8
```

Then reload Pi:

```text
/reload
```

## Validation and publish handoff

- Release-prep validation is complete: npm availability for `@diegopetrucci/pi-web-access@0.10.8` returned the expected `E404`, `npm test` passed, and `npm pack --dry-run --json` produced `@diegopetrucci/pi-web-access@0.10.8` with 30 files
- Use `docs/publish-checklist-v0.10.8.md` for reviewer signoff, PR/merge/tag with `tlh-v0.10.8`, the human-only npm publish stop, and post-publish validation after npm propagation
