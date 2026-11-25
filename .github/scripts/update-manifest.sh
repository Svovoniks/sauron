#!/usr/bin/env bash
# Rebuilds the updater manifest (latest.json) of a release from the update bundles and signatures it holds, and
# replaces the latest.json asset with it. Used by the Release workflow before the draft is published.
#
# Env: REPO (owner/name), TAG (app-vX.Y.Z), RELEASE_ID. DRY_RUN=1 prints the manifest and uploads nothing.
# Fails when a platform has no bundle or no signature, so a release is never published without it.
set -euo pipefail

: "${REPO:?}" "${TAG:?}" "${RELEASE_ID:?}"
version="${TAG#app-v}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

gh api "repos/$REPO/releases/$RELEASE_ID/assets?per_page=100" --paginate --jq '.[] | [.id, .name] | @tsv' > "$work/assets"
gh api "repos/$REPO/releases/$RELEASE_ID" --jq '.body // ""' > "$work/notes"

# updater platform key and the bundle the updater installs on it (the names tauri-action gives them)
platforms=(
  "darwin-aarch64 sauron_aarch64.app.tar.gz"
  "darwin-x86_64 sauron_x64.app.tar.gz"
  "linux-x86_64 sauron_${version}_amd64.AppImage"
  "windows-x86_64 sauron_${version}_x64_en-US.msi"
)

echo '{}' > "$work/platforms.json"
missing=0
for entry in "${platforms[@]}"; do
  read -r key bundle <<< "$entry"
  if ! cut -f2 "$work/assets" | grep -qxF "$bundle"; then
    echo "::error::$key: the release has no $bundle"
    missing=1
    continue
  fi
  sig_id=$(awk -F'\t' -v n="$bundle.sig" '$2 == n { print $1 }' "$work/assets")
  if [ -z "$sig_id" ]; then
    echo "::error::$key: the release has no $bundle.sig"
    missing=1
    continue
  fi
  # a draft's asset URLs are not public yet, so the signature is read through the API
  gh api -H "Accept: application/octet-stream" "repos/$REPO/releases/assets/$sig_id" > "$work/sig"
  url="https://github.com/$REPO/releases/download/$TAG/$bundle"
  jq --arg key "$key" --arg url "$url" --rawfile sig "$work/sig" \
    '.[$key] = { signature: ($sig | rtrimstr("\n")), url: $url }' "$work/platforms.json" > "$work/next.json"
  mv "$work/next.json" "$work/platforms.json"
  echo "$key: $bundle"
done
[ "$missing" -eq 0 ] || exit 1

jq -n --arg version "$version" --rawfile notes "$work/notes" --arg date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --slurpfile platforms "$work/platforms.json" \
  '{ version: $version, notes: ($notes | rtrimstr("\n")), pub_date: $date, platforms: $platforms[0] }' > "$work/latest.json"

if [ "${DRY_RUN:-}" = "1" ]; then
  cat "$work/latest.json"
  exit 0
fi

old_id=$(awk -F'\t' '$2 == "latest.json" { print $1 }' "$work/assets")
if [ -n "$old_id" ]; then
  gh api -X DELETE "repos/$REPO/releases/assets/$old_id"
fi
gh api -X POST -H "Content-Type: application/json" --input "$work/latest.json" \
  "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=latest.json" --jq '.name' > /dev/null
echo "latest.json now lists: $(jq -r '.platforms | keys | join(", ")' "$work/latest.json")"
