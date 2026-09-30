# The worker, for a host with a Docker daemon (see deploy/worker).
#
# It starts sandbox containers through the host's daemon socket, as a sibling of
# itself, never inside itself: repository code never shares this container, its
# environment or its files.
#
#   docker build -f docker/worker.Dockerfile -t pager-worker:latest .
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY . .
RUN corepack enable \
  && pnpm install --frozen-lockfile \
  && pnpm -r --filter './packages/**' build

# Unprivileged: DockerRunner runs sandboxes as this uid and refuses root.
RUN useradd --uid 10001 --user-group --create-home pager
USER 10001:10001
ENV NODE_ENV=production
WORKDIR /app/apps/worker
CMD ["node", "--experimental-strip-types", "src/main.ts"]
