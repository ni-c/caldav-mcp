# Template for a stdio MCP server. Placeholders: {{REPO}}.
# Before applying:
#   * check the TAG first, not just the digest: the image tracks the ACTIVE LTS
#     line, which was 24 (Krypton) on 2026-08-15 — NOT the newest tag. Node 26
#     existed then and was not LTS. Verify (group by major — a plain slice
#     returns two releases of the same line, not two lines):
#       curl -s https://nodejs.org/dist/index.json | jq -r '
#         [.[] | select(.lts != false)]
#         | map(.version | ltrimstr("v") | split(".")[0] | tonumber)
#         | unique | reverse | .[0]'
#   * then resolve that tag's digest:
#       docker pull -q node:24-alpine \
#         && docker image inspect node:24-alpine --format '{{index .RepoDigests 0}}'
#   * if the server spawns child processes, add tini and use it as ENTRYPOINT
#   * if it listens on a port, add EXPOSE + a liveness-only HEALTHCHECK

# Build stage
FROM node:24-alpine@sha256:RESOLVE_DIGEST AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:24-alpine@sha256:RESOLVE_DIGEST
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The server reports its version from package.json at runtime.
COPY package.json package-lock.json ./

# Ownership proof for the MCP Registry: must match server.json's name exactly.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/{{REPO}}"

# Drop root: the node image ships an unprivileged `node` user (uid 1000). A
# bind-mounted host directory must be chowned to 1000:1000 on the HOST — the image
# layer's ownership does not apply to it.
USER node

# stdio transport only — no port, no healthcheck. The server starts without
# credentials (tools are listable, so registries and inspectors can introspect it);
# every call then fails with setup instructions instead of reaching the API.
ENTRYPOINT ["node", "dist/index.js"]
