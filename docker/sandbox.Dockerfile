# The image repository code runs in: dependency installs, test suites, patches.
#
# The worker starts one container per command from it (DockerRunner), with no
# network except for the install, a read-only root, no capabilities and the
# worker's own unprivileged uid. Everything a supported repository needs must
# therefore be in the image already: nothing can be installed at run time.
#
#   docker build -f docker/sandbox.Dockerfile -t pager-sandbox:latest .
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Package managers installed globally rather than through corepack: corepack fetches
# a repository's declared version on first use, and a test step has no network.
# (The node image already ships yarn 1.)
RUN npm install -g pnpm@12.8.2 && npm cache clean --force && yarn --version

COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

# pnpm would otherwise switch to a repository's declared version, which needs the
# network. uv must not download interpreters, and its cache (in the sandbox's home)
# and the virtualenv (in the repository) are separate mounts, so it copies.
ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_manage_package_manager_versions=false \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy
