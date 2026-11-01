#!/usr/bin/env bash
# Vercel "Ignored Build Step": decides whether a frontend project needs a new deployment.
#   exit 0 -> nothing this project depends on changed: skip the build
#   exit 1 -> something changed (or we cannot tell): build
# Usage (from a project's vercel.json `ignoreCommand`, Root Directory = apps/<app>):
#   bash ../../scripts/vercel-ignore.sh apps/dashboard apps/widget packages/shared
# Paths are relative to the repository root. The root lockfile and manifests are always included because a
# dependency change can affect any frontend.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

if [ "$#" -eq 0 ]; then
  echo "vercel-ignore: no paths given; building"
  exit 1
fi

# First deployment or a clone without history: build.
if ! git rev-parse --verify --quiet HEAD^ >/dev/null; then
  echo "vercel-ignore: no previous commit to compare with; building"
  exit 1
fi

# On Vercel, an empty VERCEL_GIT_PREVIOUS_SHA means this branch has no successful deployment yet (a new project or a
# new branch). There is nothing deployed to compare with, so always build; skipping would leave the project without
# any deployment until a change happens to touch its folders.
if [ -n "${VERCEL:-}" ] && [ -z "${VERCEL_GIT_PREVIOUS_SHA:-}" ]; then
  echo "vercel-ignore: no previous successful deployment for this branch; building"
  exit 1
fi

# Compare with the last commit Vercel deployed for this branch when it is available (covers pushes with
# several commits and earlier skipped builds); otherwise with the parent commit.
base="${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}"
if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  base="HEAD^"
fi

if git diff --quiet "$base" HEAD -- "$@" bun.lock package.json tsconfig.base.json; then
  echo "vercel-ignore: no changes in $* since ${base:0:12}; skipping the build"
  exit 0
fi

echo "vercel-ignore: changes in $* since ${base:0:12}; building"
exit 1
