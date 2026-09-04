#!/usr/bin/env bash
# Syncs the container's "docker" group GID with /var/run/docker.sock so the
# non-root dev user can reach the HOST docker daemon (Docker-out-of-Docker).
# The socket itself is mounted by devcontainer.json.
# Rationale and trade-offs: docs/technical/devcontainer/DIND.md
set -euo pipefail

SOCKET=/var/run/docker.sock

if [ ! -S "$SOCKET" ]; then
  echo "docker: no socket at ${SOCKET} — docker CLI will not work here (expected in Codespaces, or when the host has no Docker)."
  exit 0
fi

GID="$(stat -c '%g' "$SOCKET" 2>/dev/null || echo 0)"
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

if [ "$GID" = "0" ]; then
  # Docker Desktop (macOS/Windows) mounts the socket root-owned. Opening it to
  # all container users is acceptable here: socket access is already
  # host-root-equivalent for this trusted dev container (see DIND.md).
  if [ "$(stat -c '%a' "$SOCKET")" != "666" ]; then
    $SUDO chmod 0666 "$SOCKET" \
      && echo "docker: socket opened to container users (host daemon: Docker Desktop)." \
      || echo "docker: could not open the socket — run 'sudo chmod 0666 $SOCKET' manually."
  fi
  exit 0
fi

if getent group docker >/dev/null 2>&1; then
  CURRENT="$(getent group docker | cut -d: -f3)"
  if [ "$CURRENT" != "$GID" ]; then
    $SUDO groupmod -o -g "$GID" docker
  fi
else
  $SUDO groupadd -o -g "$GID" docker
fi

if ! id -nG | tr ' ' '\n' | grep -qx docker; then
  $SUDO usermod -aG docker "$(id -un)"
fi

echo "docker: 'docker' group synced to GID ${GID}. New terminals can use the docker CLI (existing ones: run 'newgrp docker')."