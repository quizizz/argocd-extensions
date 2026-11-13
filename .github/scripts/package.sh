#!/usr/bin/env bash
set -euo pipefail

out=$1
mkdir -p "$out"
for dir in resources/extension-*.js/; do
  name=$(basename "$dir" .js)
  slug=$(sed -E 's/([a-z0-9])([A-Z])/\1-\2/g' <<<"${name#extension-}" | tr '[:upper:]' '[:lower:]')
  tar -cf "$out/$slug.tar" "$dir"
  echo "$slug"
done
