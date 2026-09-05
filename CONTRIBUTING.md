# Contributing

<!-- Template. Placeholders: {{REPO}}, {{TEST_DESCRIPTION}}, {{DEV_ENV_SNIPPET}},
     {{CI_DESCRIPTION}}. Delete this comment when applying. -->

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/{{REPO}}.git && cd {{REPO}}
npm install
npm test          # {{TEST_DESCRIPTION}}
npm run build
```

A minimal dev environment:

```sh
{{DEV_ENV_SNIPPET}}
```

## Running the integration suite

The unit tests replace `fetch`, so what they check is that this server speaks
{{BACKEND}}'s API the way its author understood it — against a stub written to
that same understanding. Only a real {{BACKEND}} can disagree. The integration
suite spawns the built server over stdio against one in Docker and calls **every
tool in the catalogue**, reading results back through {{BACKEND}}'s own API
rather than trusting the reply.

```sh
npm run build     # the suite runs dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d --wait
npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

`down -v` is not optional between runs: the suite creates things at fixed names,
and a second run against the same stack fails on what the first one left behind.

The container is a throwaway and the compose file binds `127.0.0.1` only. Point
this at nothing whose data matters — the suite calls every delete the server
has, and the harness refuses any backend URL that is not on this machine.

{{INTEGRATION_SKIPS}}

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs {{CI_DESCRIPTION}}.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, the approval flow, anything that
  builds a request URL): please describe the attack you are defending against, or the
  one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/{{REPO}}/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/{{REPO}}/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/{{REPO}}/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
