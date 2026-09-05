#!/usr/bin/env bash
#
# Stage PR preview builds into a GitHub Pages deployment.
#
# Called from .github/workflows/deploy.yml after the main site is built. PR
# preview builds (built by .github/workflows/preview.yml and uploaded as
# "preview-build-<slug>" artifacts) are fetched and unpacked into
#   dist/preview-builds/<slug>/
# so the single Pages deploy serves the real app at the site root and every
# open PR's preview under a preview-builds/<branch>/ sub-path.
#
# Uses the GitHub Actions Artifacts API directly so it always grabs the *latest*
# version of every preview artifact regardless of which workflow run produced it
# (no fragile cross-run artifact wiring).
#
# Env:
#   GITHUB_REPOSITORY  owner/repo (set automatically in Actions)
#   GITHUB_TOKEN       a token with `actions: read` (the GITHUB_TOKEN works)
#   DIST_DIR           build output directory to stage previews into (default dist)
set -euo pipefail

REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
DIST="${DIST_DIR:-dist}"
PER_PAGE="100"

API="https://api.github.com/repos/$REPO/actions/artifacts"
AUTH_HEADER=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

mkdir -p "$DIST/preview-builds"

# The List-artifacts API returns newest-first, so the first artifact we see for
# each preview-build-* slug IS its latest build. Keep that id, skip the rest.
declare -A latest
page=1
while :; do
  json="$(curl -fsSL "${AUTH_HEADER[@]}" "$API?per_page=$PER_PAGE&page=$page")"
  count="$(jq -r '.artifacts | length' <<<"$json")"
  if [[ "$count" -eq 0 ]]; then
    break
  fi
  while read -r id name expired; do
    [[ "$name" == preview-build-* ]] || continue
    [[ "$expired" == "false" ]] || continue
    slug="${name#preview-build-}"
    if [[ -z "${latest[$slug]:-}" ]]; then
      latest[$slug]="$id"
    fi
  done < <(jq -r '.artifacts[] | "\(.id) \(.name) \(.expired)"' <<<"$json")
  total="$(jq -r '.total_count' <<<"$json")"
  (( page * PER_PAGE >= total )) && break
  (( page++ ))
done

if [[ ${#latest[@]} -eq 0 ]]; then
  echo "No preview-build-* artifacts found; deploying main site only."
  exit 0
fi

for slug in "${!latest[@]}"; do
  id="${latest[$slug]}"
  dest="$DIST/preview-builds/$slug"
  tmp="$dest.tmp"
  echo "Staging preview '$slug' (artifact $id)"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  curl -fsSL "${AUTH_HEADER[@]}" "$API/$id/zip" -o "$tmp/artifact.zip"
  (cd "$tmp" && unzip -q artifact.zip && rm -f artifact.zip)
  rm -rf "$dest"
  mv "$tmp" "$dest"
done

echo "Staged ${#latest[@]} preview build(s) under $DIST/preview-builds/"
