Prepares the tlh-maintained fork for the scoped npm package `@diegopetrucci/pi-web-access@0.10.10` and the tlh release tag `tlh-v0.10.10`.

## Highlights

- Scoped npm release: `@diegopetrucci/pi-web-access@0.10.10`
- Git tag: `tlh-v0.10.10`
- Exact install pin for tlh automation: `pi install npm:@diegopetrucci/pi-web-access@0.10.10`
- Ships the TLH web-search config isolation fix so isolated profiles use `PI_CODING_AGENT_DIR` before standard Pi config locations
- Release-prep validation completed locally: npm availability returned expected `E404` / unpublished, `npm test` passed (`11`/`0`), and `npm pack --dry-run --json` produced `@diegopetrucci/pi-web-access@0.10.10` with `30` files; reviewer signoff, PR/merge/tag, npm publish, and post-publish verification remain pending in `docs/publish-checklist-v0.10.10.md`

## Install

```bash
pi install npm:@diegopetrucci/pi-web-access@0.10.10
```

Then reload Pi:

```text
/reload
```

## Validation and publish handoff

- Release-prep validation has been run and recorded in `docs/publish-checklist-v0.10.10.md`: expected npm `E404` / unpublished for `@diegopetrucci/pi-web-access@0.10.10`, `npm test` passed (`11`/`0`), and `npm pack --dry-run --json` produced `@diegopetrucci/pi-web-access@0.10.10` with `30` files
- Reviewer signoff, PR/merge/tag with `tlh-v0.10.10`, the human-only npm publish stop, public npm publish, and post-publish validation after npm propagation remain pending
