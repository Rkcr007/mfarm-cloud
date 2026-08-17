# Control plane image.
#
# Build from the REPOSITORY ROOT, not from this directory — the API depends on the `@mfarm/protocol`
# workspace, so the build context has to contain both:
#
#   docker build -f apps/api/Dockerfile -t mfarm-api .
#
# There is no build step and no bundler. Node strips TypeScript natively (>=22.6), which is why the
# repo has no `dist/`. That also means types are ERASED, NEVER CHECKED — `npm run typecheck` in CI is
# the only thing standing between this image and a wrong field name, so an image that builds proves
# nothing about types.

FROM node:22-alpine AS deps

WORKDIR /app

# Manifests first, so a change to source does not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/api/package.json apps/api/

# `npm ci` rather than `npm install`: it fails on a lockfile that has drifted instead of quietly
# resolving something newer than what CI tested. --omit=dev keeps typescript and @types out of the
# runtime image.
RUN npm ci --omit=dev

# ---------------------------------------------------------------- runtime

FROM node:22-alpine AS runtime

# Postgres client tools for the migration entrypoint below and for anyone exec-ing in to look at
# something at 3am. ~10MB, and worth it the first time you need psql and do not have it.
RUN apk add --no-cache postgresql16-client tini

WORKDIR /app
ENV NODE_ENV=production

# The WHOLE installed tree, not just /app/node_modules. npm workspaces do not hoist everything:
# this lockfile places `@fastify/rate-limit` at `apps/api/node_modules/`, so copying only the root
# directory produced an image that built cleanly and then died at startup with
# ERR_MODULE_NOT_FOUND. Copying the tree is version-resolution-agnostic — it does not matter which
# packages npm decided to hoist.
COPY --from=deps /app ./

# Source last, layered over the manifests already there. Docker merges directories rather than
# replacing them, and .dockerignore excludes node_modules from the build context, so nothing
# installed above is clobbered here.
COPY packages/protocol ./packages/protocol
COPY apps/api ./apps/api

# Runs as the image's built-in unprivileged user. The control plane never writes to disk — it holds
# no state that is not in Postgres — so nothing here needs to be writable.
USER node

EXPOSE 3000

# tini as PID 1. Without an init, Node is PID 1 and the default SIGTERM handling means
# `docker stop` can kill the process outright rather than letting main.ts run its drain — which
# exists specifically to finish in-flight requests and clear the reaper before closing the pools.
ENTRYPOINT ["/sbin/tini", "--"]

# The strip-types flag is explicit rather than relying on the Node 22 default, so bumping the base
# image cannot silently change how source is loaded.
CMD ["node", "--experimental-strip-types", "apps/api/src/main.ts"]
