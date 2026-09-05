# Connecting clients

## Claude Code

```sh
claude mcp add caldav-mcp -- npx -y @ni-c/caldav-mcp
```

## Claude Desktop

## Codex

## MCP Inspector

## Docker

<!-- "Through mcp-hub" goes here: after Docker, which is the last "how you actually
     run it" section, and before anything about the artifact (Pinning a version,
     From source, Verifying what you install). It is a peer of the other clients,
     never ranked above them.

     The third paragraph is the one that matters and must not be cut. It is the
     only place the two filters sit side by side, and "allowTools": ["essential"]
     in mcp.json — which does nothing — is exactly the mistake this section exists
     to prevent. -->

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) serves many stdio MCP servers from one container
behind a single HTTPS endpoint, so caldav-mcp can be reached from clients that cannot
spawn a local process — ChatGPT connectors, Claude on the web, Cursor — without a
container, a hostname and an OAuth stack of its own.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you
already have:

```json
{
  "mcpServers": {
    "caldav-mcp": {
      "command": "npx",
      "args": ["-y", "@ni-c/caldav-mcp"],
      "env": {
        "CALDAV_URL": "https://service.example.com",
        "CALDAV_TOKEN": "…",
        "CALDAV_ALLOW_TOOLS": "essential"
      },
      "denyTools": ["delete_event"]
    }
  }
}
```

`allowTools` and `denyTools` are the hub's **own** per-server filter and take exact
tool names or `list_*` prefixes — the same syntax as the two environment variables,
so a list moves between them verbatim. What does **not** move is `essential`: that
preset is a caldav-mcp feature and belongs in `env` as shown.
`"allowTools": ["essential"]` would be a name the hub cannot resolve.

The two compose, and it is worth knowing which does what: the server registers what
its environment variables allow, and the hub exposes what its arrays allow.
Filtering in the server is the tighter of the two — the tool is never built.

Register `https://your-host/caldav-mcp/mcp` as a connector and you get this server
alone. Register the hub's `/hub` endpoint instead and you reach _every_ server
behind it through six meta-tools, which is the answer worth having once you run
several of these at once.
