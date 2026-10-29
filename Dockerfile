# Build stage
#
# node:26-alpine is the ACTIVE LTS line, not the newest tag — roughly half of all
# Node majors never become LTS, so "newest" and "supported" are different things.
# Only the major belongs in this note. A patch version written here would be
# falsified by the next digest bump, which would arrive red for a reason nobody
# needs to act on. CI checks the claim instead, on every run
# (.github/scripts/check-base-image-pin.sh): `node:lts-alpine` and
# `node:26-alpine` must resolve to the same digest, and the digest pinned below
# must be a Node 26 image. The day 26 leaves LTS, that fails.
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

# Runtime
FROM node:26-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# The server reports its version from package.json at runtime. The lockfile
# is not copied: nothing reads it here, and a file nothing reads is only
# another thing a scanner has to be told about.
COPY package.json ./

# The base image's bundled package managers are a frequent source of HIGH
# findings and this image never installs anything — remove them rather than
# carrying their CVEs. All of them: npm and npx were removed first, and yarn
# and corepack stayed behind for a release, which is the kind of half-measure
# `docker run --entrypoint sh … -c 'ls /opt; which yarn npm npx corepack'`
# after a build is there to catch.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

# Ownership proof for the MCP Registry: must match server.json's name exactly.
LABEL io.modelcontextprotocol.server.name="io.github.ni-c/caldav-mcp"

# Drop root: the node image ships an unprivileged `node` user (uid 1000). This
# server never writes to the filesystem — attachments are reported by URL and
# never fetched — so there is no bind mount to chown and nothing else follows
# from it here.
USER node

# stdio transport only — no port, no healthcheck. The server starts without
# credentials (tools stay listable, so registries and inspectors can introspect
# it); every call then fails with setup instructions instead of reaching a server.
ENTRYPOINT ["node", "dist/index.js"]
