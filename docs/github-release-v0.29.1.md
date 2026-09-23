# GitHub release — `tlh-v0.29.1`

## Summary

Publish `@diegopetrucci/pi-web-access@0.29.1`, a The Last Harness selective
security/token-efficiency port through upstream `192ac18`. This is not upstream
v0.29.0 feature parity.

The package exposes only Exa `web_search`, local `fetch_content`, and local
`get_search_content`. It requires Node >=22.19.0 and an absolute
`PI_CODING_AGENT_DIR`; trusted publishing validates the tests, typecheck, and
exact npm package shape before publishing with provenance.

## Install in the compatible upstream Pi runtime

```bash
pi install npm:@diegopetrucci/pi-web-access@0.29.1
```

After publication, update the external tlh repository's package pin and its
obsolete curator/search documentation in a separately authorized follow-up.
Those external changes are not part of this tag.
