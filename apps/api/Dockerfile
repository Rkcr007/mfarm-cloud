# Control plane image.
#
# Build from the REPOSITORY ROOT, not from this directory — the API depends on the `@mfarm/protocol`
# workspace, so the build context has to contain both:
#
#   docker build -f apps/api/Dockerfile -t mfarm-api .
#
# The API ITSELF has no build step and no bundler. Node strips TypeScript natively (>=22.6), which is
# why the repo has no `dist/`. That also means types are ERASED, NEVER CHECKED — `npm run typecheck`
# in CI is the only thing standing between this image and a wrong field name, so an image that builds
# proves nothing about types.
#
# THE CONSOLE IS THE ONE EXCEPTION, and it is built here rather than committed. Its output could have
# been checked into `apps/api/public/app/`, which would have kept this file a pure copy — but a
# committed build artifact drifts the moment somebody edits a component and forgets to rebuild, and
# the symptom is a deployed console that is silently one commit stale with nothing anywhere saying
# so. Building it in the image makes that impossible: the assets in the image are always the assets
# the source in the image produces.

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

# ---------------------------------------------------------------- console

# Its own stage, with dev dependencies, so vite and react never reach the runtime image.
FROM node:22-alpine AS console

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/

# The full install, unlike the deps stage: a bundler IS a dev dependency.
RUN npm ci

COPY apps/console ./apps/console

# THE SHARED LIVE VIEW (ADR-0022). The React console does not reimplement Cuttlefish's signalling —
# it imports `live.js`, the same file the old console loads unbuilt, so the two cannot drift. That
# import crosses a package boundary, so both files have to be in THIS stage's context or the build
# fails here and nowhere else.
#
# Named explicitly rather than copying all of `apps/api/public`, for two reasons: that directory
# also holds the 200 KB old console, which this stage has no use for; and a narrow copy makes the
# dependency visible, so anyone who adds a second cross-package import gets a build error naming the
# file instead of a bundle that silently lost its types.
#
# THIS LINE IS WHY RELEASE FAILED ON 2026-09-02 WHILE CI WAS GREEN. CI runs the same
# `npm run build --workspace apps/console` against a FULL checkout, where the import resolves; only
# the image build has a narrowed context. `live.d.ts` is not optional — without it the module still
# resolves through `live.js` and every callback parameter becomes an implicit `any`, which `strict`
# rejects (TS7006).
COPY apps/api/public/live.js apps/api/public/live.d.ts ./apps/api/public/

# Emits `apps/api/public/app/` — fixed filenames, no hashing, so the API's allowlist can name them.
RUN npm run build --workspace apps/console

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

# AFTER `apps/api`, because that copy would otherwise land on top of it. `public/app` is gitignored
# and absent from the build context, so this is the only thing that puts the console in the image.
COPY --from=console /app/apps/api/public/app ./apps/api/public/app

# The app library's blobs (migration 014) and session artifacts (migration 019). Created in the
# image, owned by `node`, and that ownership is the entire reason this line exists: Docker seeds a
# fresh named volume from the image directory it is mounted over, and a mount point that does not
# exist in the image gets a root-owned volume instead — so an unprivileged process cannot write to
# it and every upload fails with EACCES on a deployment that looked fine until someone uploaded
# something.
#
# EVERY DIRECTORY MOUNTED AS A VOLUME IN docker-compose.prod.yml MUST BE LISTED HERE. The artifacts
# volume was added without its mkdir on 2026-08-23 and did exactly what the paragraph above
# describes: the deploy succeeded, the console was fine, and the first release-time capture failed
# with `EACCES: mkdir '/var/lib/mfarm/artifacts/tmp'` — swallowed by the worker, as designed, so the
# only visible symptom was a session that had no evidence. Note that fixing the image does NOT
# repair a volume that already exists, because Docker seeds ownership only when it creates one:
# an already-deployed box needs a one-time
#     docker compose -f deploy/docker-compose.prod.yml exec -u root api \
#       chown -R node:node /var/lib/mfarm/artifacts
RUN mkdir -p /var/lib/mfarm/apps /var/lib/mfarm/artifacts && chown -R node:node /var/lib/mfarm

# THE IMAGE'S OWN IDENTITY, and it goes here — after the source — for two reasons. It changes on
# every commit, so any earlier position would invalidate the dependency and source layers and turn a
# one-line fix into a full rebuild. And it must describe the source ALREADY COPIED above: an ARG
# read before the COPY would name a commit whose code is not necessarily what shipped.
#
# `unknown` is the default rather than a git call, because a build with no SHA passed genuinely does
# not have a release identity and should say so. `/v1/version` reports whatever lands here, so a
# lie here is a lie in the console header.
ARG GIT_SHA=unknown
ARG BUILT_AT=
ENV MFARM_GIT_SHA=$GIT_SHA
ENV MFARM_BUILT_AT=$BUILT_AT

# Runs as the image's built-in unprivileged user. The one path it writes to is APP_STORE_DIR above,
# which is a mounted volume; everything else this process knows is in Postgres.
USER node

EXPOSE 3000

# tini as PID 1. Without an init, Node is PID 1 and the default SIGTERM handling means
# `docker stop` can kill the process outright rather than letting main.ts run its drain — which
# exists specifically to finish in-flight requests and clear the reaper before closing the pools.
ENTRYPOINT ["/sbin/tini", "--"]

# The strip-types flag is explicit rather than relying on the Node 22 default, so bumping the base
# image cannot silently change how source is loaded.
CMD ["node", "--experimental-strip-types", "apps/api/src/main.ts"]
