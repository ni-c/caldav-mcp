# Getting started

## Requirements

- Node.js ≥ 22
- A running {{SERVICE}} instance
- An API token with the scopes listed under [Configuration](/guide/configuration)

## Run it

```sh
{{ENV_PREFIX}}_URL=https://service.example.com {{ENV_PREFIX}}_TOKEN=… npx -y {{PACKAGE_NAME}}
```

Without credentials the server still starts and lists its tools; every call then
fails with setup instructions instead of reaching the API.
