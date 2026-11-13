#!/usr/bin/env bash
set -euo pipefail

tag=$1
dir=$2
shift 2
slugs=("$@")
base=https://github.com/quizizz/argocd-extensions/releases/download

files=$(grep -rl --include=argocd.yaml "$base/" "$dir/manifests" || true)
if [ -z "$files" ]; then
  echo "no argocd.yaml under $dir/manifests references $base" >&2
  exit 1
fi

for f in $files; do
  noeol=$(tail -c1 "$f")
  sed -E "s#$base/v[0-9][0-9.]*/#$base/$tag/#g" "$f" > "$f.tmp"
  mv "$f.tmp" "$f"

  for slug in "${slugs[@]}"; do
    if grep -q "$base/$tag/$slug.tar" "$f"; then
      continue
    fi
    awk -v base="$base/" -v url="$base/$tag/$slug.tar" -v name="$slug-extension" '
      { lines[NR] = $0 }
      index($0, base) { last = NR }
      END {
        if (!last || lines[last - 3] !~ /^ *- name: /) {
          print "unexpected extensionList layout in " FILENAME > "/dev/stderr"
          exit 1
        }
        match(lines[last - 3], /^ */)
        i = substr(lines[last - 3], 1, RLENGTH)
        for (n = 1; n <= NR; n++) {
          print lines[n]
          if (n == last) {
            print i "- name: " name
            print i "  env:"
            print i "    - name: EXTENSION_URL"
            print i "      value: " url
          }
        }
      }' "$f" > "$f.tmp"
    mv "$f.tmp" "$f"
  done

  if [ -n "$noeol" ]; then
    perl -pi -e 'chomp if eof' "$f"
  fi

  grep -oE "$base/$tag/[a-z0-9-]+\.tar" "$f" | sed -E 's#.*/##; s#\.tar$##' | while read -r s; do
    if ! printf '%s\n' "${slugs[@]}" | grep -qx "$s"; then
      echo "$f references $s.tar, which release $tag does not ship" >&2
      exit 1
    fi
  done
done
