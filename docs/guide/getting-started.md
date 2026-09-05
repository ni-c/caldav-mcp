# Getting started

## Requirements

- Node.js ≥ 22
- A running CalDAV instance
- An API token with the scopes listed under [Configuration](/guide/configuration)

## Run it

```sh
CALDAV_URL=https://service.example.com CALDAV_TOKEN=… npx -y @ni-c/caldav-mcp
```

Without credentials the server still starts and lists its tools; every call then
fails with setup instructions instead of reaching the API.
