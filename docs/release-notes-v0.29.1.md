# Release notes — v0.29.1

## Scope

`@diegopetrucci/pi-web-access@0.29.1` is a The Last Harness selective
security/token-efficiency port through upstream commit `192ac18`. It is not
upstream v0.29.0 feature parity.

The release contains only the Exa-backed `web_search`, local `fetch_content`,
and local `get_search_content` tools. It requires Node >=22.19.0 and an
absolute `PI_CODING_AGENT_DIR`; settings and fetched-content cache stay under
that profile.

## Handoff

- npm package: `@diegopetrucci/pi-web-access@0.29.1`
- compatible upstream Pi runtime install: `pi install npm:@diegopetrucci/pi-web-access@0.29.1`
- tag: `tlh-v0.29.1`
- publish: existing GitHub Actions trusted-publishing workflow

The external tlh pin and obsolete curator/search documentation are intentionally
unchanged and require a separately authorized post-publication follow-up.
