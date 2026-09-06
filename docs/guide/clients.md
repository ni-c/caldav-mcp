# Connecting clients

Every example below is the same three variables, and there is no fourth. See
[Configuration](/guide/configuration#signing-in) for why there is no token to
obtain, and add `-e CALDAV_TIMEZONE=Europe/Berlin` wherever a time typed without
an offset should not mean UTC.

## Claude Code

```sh
claude mcp add caldav \
  -e CALDAV_URL=https://dav.example.net \
  -e CALDAV_USERNAME=you \
  -e CALDAV_PASSWORD=your-app-password \
  -- npx -y @ni-c/caldav-mcp
```

Add `-e CALDAV_CALENDARS=work` to fence it to one calendar, and
`-e CALDAV_READ_ONLY=true` to register only the read tools.

## Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "caldav": {
      "command": "npx",
      "args": ["-y", "@ni-c/caldav-mcp"],
      "env": {
        "CALDAV_URL": "https://dav.example.net",
        "CALDAV_USERNAME": "you",
        "CALDAV_PASSWORD": "your-app-password"
      }
    }
  }
}
```

## Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.caldav]
command = "npx"
args = ["-y", "@ni-c/caldav-mcp"]
env = { CALDAV_URL = "https://dav.example.net", CALDAV_USERNAME = "you", CALDAV_PASSWORD = "your-app-password" }
```

## MCP Inspector

For looking at one tool by hand:

```sh
npx @modelcontextprotocol/inspector --cli npx -y @ni-c/caldav-mcp \
  -e CALDAV_URL=https://dav.example.net \
  -e CALDAV_USERNAME=you \
  -e CALDAV_PASSWORD=your-app-password \
  --method tools/list
```

Two things about that command line, both of which cost an afternoon at least
once. The inspector does **not** pass the ambient environment through to the
server it spawns, so exporting the variables first does nothing — they go in
`-e` flags. And those flags have to come **after** the target command: put them
before it and the positional parsing shifts, the target is lost, and the
inspector quietly connects to whatever server its own catalogue file lists
instead.

Drop `--cli` for the browser UI, where the variables are entered in a form.

## Docker

```sh
docker run --rm -i \
  -e CALDAV_URL=https://dav.example.net \
  -e CALDAV_USERNAME=you \
  -e CALDAV_PASSWORD=your-app-password \
  ghcr.io/ni-c/caldav-mcp
```

`-i` is required and `-t` must not be: stdin and stdout are the protocol. The
image runs as the unprivileged `node` user, carries no package manager, and
writes nothing to disk.

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
        "CALDAV_URL": "https://dav.example.net",
        "CALDAV_USERNAME": "you",
        "CALDAV_PASSWORD": "your-app-password",
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
