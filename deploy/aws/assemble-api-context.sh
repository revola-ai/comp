#!/usr/bin/env bash
# Assembles the api runtime tree for the image (deploy/aws/Dockerfile, stage api-context).
#
#   assemble-api-context.sh --repo DIR --prod DIR --out DIR
#
# --repo  the monorepo after `bun install`, the library builds and `nest build`
# --prod  the same lockfile installed with --production for @trycompai/api only
# --out   written fresh; it becomes /app in the image:
#           node_modules/            production modules, each workspace link replaced by
#                                    the package's built output
#           apps/api/                nest build output, package.json, prisma schema files,
#                                    JSON assets read at runtime, api-only nested modules
# The layout mirrors the monorepo so the api and every package resolve the same module
# versions they resolve in development.
set -euo pipefail

# Workspace packages apps/api reaches at runtime (transitive production dependencies).
# tests/build-context-drift.test.ts keeps this list equal to the package graph.
readonly WORKSPACE_PACKAGES=(auth billing company db email integration-platform utils)

fail() {
  echo "assemble-api-context: $*" >&2
  exit 1
}

repo="" prod="" out=""
while (($# > 0)); do
  case "$1" in
    --repo) repo="${2:-}"; shift 2 ;;
    --prod) prod="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) fail "unknown argument: $1 (usage: --repo DIR --prod DIR --out DIR)" ;;
  esac
done
[[ -n "$repo" && -n "$prod" && -n "$out" ]] || fail "usage: --repo DIR --prod DIR --out DIR"
[[ -d "$repo/apps/api" ]] || fail "$repo/apps/api does not exist"
[[ -d "$prod/node_modules" ]] || fail "$prod/node_modules does not exist"

api_src="$repo/apps/api"
out_api="$out/apps/api"

# nest build writes dist/src when the program stays inside apps/api, and
# dist/apps/api/src when it pulls in sources from elsewhere in the repo.
if [[ -f "$api_src/dist/src/main.js" ]]; then
  dist_root="$api_src/dist"
elif [[ -f "$api_src/dist/apps/api/src/main.js" ]]; then
  dist_root="$api_src/dist/apps/api"
else
  fail "src/main.js is missing from apps/api/dist (looked in dist/src and dist/apps/api/src); run nest build first"
fi
[[ -d "$repo/node_modules/.prisma/client" ]] ||
  fail "node_modules/.prisma/client is missing; prisma generate must run before assembly"
for name in "${WORKSPACE_PACKAGES[@]}"; do
  [[ -f "$repo/packages/$name/package.json" ]] || fail "packages/$name/package.json is missing"
  [[ "$name" == utils || -d "$repo/packages/$name/dist" ]] ||
    fail "packages/$name/dist is missing; build the workspace libraries first"
done

rm -rf "$out"
mkdir -p "$out_api"

# Production modules, and the client prisma generated for the api's schema.
cp -R "$prod/node_modules" "$out/node_modules"
if [[ -d "$prod/apps/api/node_modules" ]]; then
  cp -R "$prod/apps/api/node_modules" "$out_api/node_modules"
fi
rm -rf "$out/node_modules/.prisma"
cp -R "$repo/node_modules/.prisma" "$out/node_modules/.prisma"

# Build output. dist/prisma holds the compiled @db client; the committed
# apps/api/prisma/client.js is a stale artifact and is never copied.
cp -R "$dist_root/." "$out_api/"
find "$out_api" -name '*.tsbuildinfo' -delete
cp "$api_src/package.json" "$out_api/package.json"
mkdir -p "$out_api/prisma/schema"
cp "$api_src"/prisma/schema/*.prisma "$out_api/prisma/schema/"
# JSON the api reads from disk next to its compiled code (for example the SOA seed).
(cd "$api_src" && find src -name '*.json' -type f) | while IFS= read -r asset; do
  mkdir -p "$out_api/$(dirname "$asset")"
  cp "$api_src/$asset" "$out_api/$asset"
done

# utils ships TypeScript sources only. Node refuses to strip types under node_modules,
# so its sources are transpiled to CommonJS and its exports pointed at the .js files.
ship_utils() {
  local src="$1" dest="$2" files=()
  while IFS= read -r file; do files+=("$file"); done < <(
    find "$src/src" -name '*.ts' ! -name '*.test.ts' ! -name '*.d.ts' -type f
  )
  ((${#files[@]} > 0)) || fail "packages/utils/src has no TypeScript sources"
  "$repo/node_modules/.bin/esbuild" "${files[@]}" --log-level=warning --format=cjs \
    --platform=node --target=node22 --outbase="$src/src" --outdir="$dest/src"
  node -e '
    const fs = require("fs");
    const [from, to] = process.argv.slice(1);
    const toJs = (value) => (typeof value === "string" ? value.replace(/\.ts$/, ".js") : value);
    const manifest = JSON.parse(fs.readFileSync(from, "utf8"));
    if (manifest.main) manifest.main = toJs(manifest.main);
    if (manifest.exports) {
      manifest.exports = Object.fromEntries(
        Object.entries(manifest.exports).map(([key, value]) => [key, toJs(value)]),
      );
    }
    delete manifest.types;
    fs.writeFileSync(to, JSON.stringify(manifest, null, 2) + "\n");
  ' "$src/package.json" "$dest/package.json"
}

scope="$out/node_modules/@trycompai"
mkdir -p "$scope"
for name in "${WORKSPACE_PACKAGES[@]}"; do
  src="$repo/packages/$name"
  dest="$scope/$name"
  rm -rf "$dest"
  mkdir -p "$dest"
  if [[ "$name" == utils ]]; then
    ship_utils "$src" "$dest"
  else
    cp "$src/package.json" "$dest/package.json"
    cp -R "$src/dist" "$dest/dist"
  fi
  if [[ -d "$prod/packages/$name/node_modules" ]]; then
    cp -R "$prod/packages/$name/node_modules" "$dest/node_modules"
  fi
done

# Any workspace link still present points at a package the image does not ship.
find "$scope" -mindepth 1 -maxdepth 1 -type l -exec rm -f {} +

[[ -f "$out_api/src/main.js" ]] || fail "src/main.js is missing from the assembled tree"
