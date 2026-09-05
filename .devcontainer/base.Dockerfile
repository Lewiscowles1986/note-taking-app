# syntax=docker/dockerfile:1

# Devcontainer BASE image for Note Haven.
#
# Built OUTSIDE the devcontainer tooling with plain docker buildx
# (scripts/build-devcontainer-base.sh locally, CI on main/schedule) and
# consumed by devcontainer.json via "image". Because the devcontainer CLI
# never rewrites this file, full Dockerfile syntax is available here
# (including ARG-before-FROM). Multi-arch: builds natively for whichever
# platform buildx targets (linux/amd64, linux/arm64).

ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.58.2-noble

# --- Stage 1: evaluate flake.lock and build the pinned toolchain -------------
# flake.lock pins the exact nixpkgs revision, which pins Node.js, npm, git and
# the docker CLI.
FROM nixos/nix:2.35.2 AS toolchain

WORKDIR /build
COPY flake.nix flake.lock ./

# Sandboxing is disabled because nix builds inside a plain (unprivileged)
# container cannot create user namespaces. The toolchain build is a pure
# symlink environment, so the sandbox buys nothing here.
#
# The toolchain gets its OWN profile: the nixos/nix image ships a default
# profile (with its own nix/git) that would collide with ours.
RUN echo "sandbox = false" > /etc/nix/nix.conf \
 && echo "experimental-features = nix-command flakes" >> /etc/nix/nix.conf \
 && nix profile install --profile /nix/var/nix/profiles/toolchain .#default \
 && nix-collect-garbage -d

# --- Stage 2: dev container base ---------------------------------------------
# Base: Microsoft's Playwright image (Ubuntu 24.04 "noble", multi-arch). It
# ships the browser builds that match the @playwright/test version in
# package-lock.json, plus every OS library they need. When you bump
# @playwright/test, bump the ARG default to "v<version>-noble" — and also
# update scripts/e2e-docker.sh, which pins the same image for host-side runs.
# .devcontainer/post-create.sh fails fast if the pair ever drifts apart.
FROM ${PLAYWRIGHT_IMAGE}
ARG PLAYWRIGHT_IMAGE

# Bring the nix store (with the pinned toolchain and its profile) over from
# stage 1. Non-root users execute these binaries directly; nix commands are
# intentionally NOT available in the final image — edit flake.nix and rebuild
# the base image instead.
COPY --from=toolchain /nix /nix

# Full image tag, consumed by .devcontainer/post-create.sh for the
# npm-<->browser pairing check.
ENV PW_IMAGE_TAG=${PLAYWRIGHT_IMAGE}

# Pinned toolchain from stage 1. It precedes the base image PATH, so
# node/npm/git/docker resolve to the flake-locked versions, not the distro's.
ENV PATH="/nix/var/nix/profiles/toolchain/bin:${PATH}"

# The Playwright image ships without sudo; dev containers conventionally give
# the non-root user passwordless sudo (used by the docker socket setup below).
RUN apt-get update \
 && apt-get install -y --no-install-recommends sudo \
 && rm -rf /var/lib/apt/lists/*

# Normalize the user: the base image carries ubuntu(1000) and pwuser(1001).
# Replace both with the conventional devcontainer "vscode" user on uid/gid
# 1000 so file ownership lines up with typical Linux hosts and Codespaces.
RUN set -eux; \
    rm -f /etc/sudoers.d/pwuser /etc/sudoers.d/ubuntu; \
    userdel -r pwuser 2>/dev/null || true; \
    userdel -r ubuntu 2>/dev/null || true; \
    groupdel pwuser 2>/dev/null || true; \
    groupdel ubuntu 2>/dev/null || true; \
    groupadd --gid 1000 vscode; \
    useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash vscode; \
    echo "vscode ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/vscode; \
    chmod 0440 /etc/sudoers.d/vscode; \
    mkdir -p /workspaces; \
    chown vscode:vscode /workspaces; \
    git config --system --add safe.directory '*'

# Docker-out-of-Docker: devcontainer.json mounts the HOST daemon socket; the
# group GID is synced to the socket at container start so the non-root user
# can use it. See docs/technical/devcontainer/DIND.md for the reasoning,
# trade-offs and the "why not Docker-in-Docker" answer.
COPY .devcontainer/fix-docker-group.sh /usr/local/sbin/fix-docker-group
RUN chmod 0755 /usr/local/sbin/fix-docker-group

USER vscode