#!/bin/bash

# Version Bump Script
# Usage: ./bump-version.sh 0.2.0

set -e

if [ -z "$1" ]; then
  echo "Usage: ./bump-version.sh <version>"
  echo "Example: ./bump-version.sh 0.2.0"
  exit 1
fi

NEW_VERSION=$1

echo "🔄 Bumping version to $NEW_VERSION..."

# Update client/package.json
if [ -f "client/package.json" ]; then
  echo "  → Updating client/package.json"
  sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" client/package.json
fi

# Update desktop/package.json
if [ -f "desktop/package.json" ]; then
  echo "  → Updating desktop/package.json"
  sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" desktop/package.json
fi

# Update mobile/package.json
if [ -f "mobile/package.json" ]; then
  echo "  → Updating mobile/package.json"
  sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" mobile/package.json
fi

# Update server/package.json
if [ -f "server/package.json" ]; then
  echo "  → Updating server/package.json"
  sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" server/package.json
fi

# Update ops/package.json
if [ -f "ops/package.json" ]; then
  echo "  → Updating ops/package.json"
  sed -i "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" ops/package.json
fi

echo "✅ Version bumped to $NEW_VERSION"
echo ""
echo "Next steps:"
echo "  1. Review changes: git diff"
echo "  2. Commit: git commit -am 'Bump version to $NEW_VERSION'"
echo "  3. Tag: git tag -a v$NEW_VERSION -m 'Release version $NEW_VERSION'"
echo "  4. Push: git push origin main --tags"
echo "  5. Create release on GitHub"
