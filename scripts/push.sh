#!/usr/bin/env bash
# Push to remote and auto-tag with the commit count.
set -euo pipefail

git push
COUNT=$(git rev-list --count HEAD)
git tag "v${COUNT}" 2>/dev/null || true  # Skip if tag exists
git push --tags 2>/dev/null || true
echo "Pushed and tagged v${COUNT}"
