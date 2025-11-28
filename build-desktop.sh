#!/bin/bash
#
# Datasetto Desktop Builder for Radxa/ARM
# Builds Electron app using Docker - no npm/node required on host
#
# Usage:
#   ./build-desktop.sh              # Build for Linux ARM64 (native)
#   ./build-desktop.sh linux        # Build Linux x64 + ARM64
#   ./build-desktop.sh win          # Build Windows x64 (via Wine)
#   ./build-desktop.sh all          # Build all platforms
#
# Requirements:
#   - Docker and Docker Compose installed
#   - Sufficient disk space (~2GB for builder image + builds)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM="${1:-linux-native}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}🚀 Datasetto Desktop Builder${NC}"
echo -e "${CYAN}=============================${NC}"
echo -e "Platform: ${YELLOW}$PLATFORM${NC}"
echo -e "Host Arch: ${YELLOW}$(uname -m)${NC}"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed.${NC}"
    echo "Install with: curl -fsSL https://get.docker.com | sh"
    exit 1
fi

# Check if Docker daemon is running
if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Docker daemon is not running.${NC}"
    echo "Start with: sudo systemctl start docker"
    exit 1
fi

cd "$SCRIPT_DIR"

# Create release directory
mkdir -p desktop/release

# Build function
build_with_docker() {
    local PLATFORM_FLAGS="$1"
    local DESCRIPTION="$2"
    
    echo -e "${CYAN}📦 Building: $DESCRIPTION${NC}"
    echo ""
    
    # Build the builder image
    docker build -t datasetto-builder -f desktop/Dockerfile.builder .
    
    # Run the builder
    docker run --rm \
        -v "$SCRIPT_DIR/desktop/release:/build/desktop/release" \
        datasetto-builder \
        $PLATFORM_FLAGS
}

# Generate manifest
generate_manifest() {
    echo -e "${CYAN}📝 Generating build manifest...${NC}"
    
    local MANIFEST_FILE="$SCRIPT_DIR/desktop/release/builds.json"
    local VERSION=$(grep '"version"' "$SCRIPT_DIR/desktop/package.json" | head -1 | sed 's/.*"version": "\([^"]*\)".*/\1/')
    local BUILD_DATE=$(date -Iseconds 2>/dev/null || date +%Y-%m-%dT%H:%M:%S%z)
    
    echo "{" > "$MANIFEST_FILE"
    echo "  \"version\": \"$VERSION\"," >> "$MANIFEST_FILE"
    echo "  \"buildDate\": \"$BUILD_DATE\"," >> "$MANIFEST_FILE"
    echo "  \"builds\": [" >> "$MANIFEST_FILE"
    
    local FIRST=true
    for file in "$SCRIPT_DIR/desktop/release"/*; do
        [ ! -f "$file" ] && continue
        
        local filename=$(basename "$file")
        
        # Skip non-distributable files
        case "$filename" in
            *.blockmap|*.yml|*.yaml|builds.json|builder-*) continue ;;
        esac
        
        # Get file size
        local size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)
        
        # Determine platform
        local platform="unknown"
        case "$filename" in
            *-win-*|*.exe) platform="windows" ;;
            *-mac-*|*.dmg) platform="macos" ;;
            *-linux-*|*.AppImage|*.deb) platform="linux" ;;
        esac
        
        # Determine arch
        local arch="x64"
        case "$filename" in
            *arm64*|*aarch64*) arch="arm64" ;;
        esac
        
        # Determine type
        local type="unknown"
        case "$filename" in
            *.exe) 
                if [[ "$filename" == *"portable"* ]]; then type="portable"
                else type="installer"; fi ;;
            *.dmg) type="dmg" ;;
            *.AppImage) type="appimage" ;;
            *.deb) type="deb" ;;
            *.zip) type="zip" ;;
        esac
        
        # Format size
        local size_fmt
        if [ "$size" -gt 1073741824 ]; then
            size_fmt="$(awk "BEGIN {printf \"%.2f\", $size/1073741824}") GB"
        elif [ "$size" -gt 1048576 ]; then
            size_fmt="$(awk "BEGIN {printf \"%.2f\", $size/1048576}") MB"
        else
            size_fmt="$(awk "BEGIN {printf \"%.2f\", $size/1024}") KB"
        fi
        
        if [ "$FIRST" = true ]; then
            FIRST=false
        else
            echo "," >> "$MANIFEST_FILE"
        fi
        
        cat >> "$MANIFEST_FILE" << EOF
    {
      "filename": "$filename",
      "platform": "$platform",
      "arch": "$arch",
      "type": "$type",
      "size": $size,
      "sizeFormatted": "$size_fmt"
    }
EOF
    done
    
    echo "" >> "$MANIFEST_FILE"
    echo "  ]" >> "$MANIFEST_FILE"
    echo "}" >> "$MANIFEST_FILE"
}

# Main build logic
case "$PLATFORM" in
    linux-native|native)
        # Build for host architecture (ARM64 on Radxa)
        build_with_docker "--linux AppImage deb" "Linux $(uname -m)"
        ;;
    linux)
        # Build for x64 (may need QEMU on ARM)
        build_with_docker "--linux AppImage deb --x64" "Linux x64"
        ;;
    linux-arm|arm|arm64)
        build_with_docker "--linux AppImage deb --arm64" "Linux ARM64"
        ;;
    win|windows)
        echo -e "${YELLOW}⚠️  Windows builds use Wine and may be slow on ARM${NC}"
        build_with_docker "--win nsis portable --x64" "Windows x64"
        ;;
    all)
        echo -e "${YELLOW}⚠️  Building all platforms - this will take a while${NC}"
        build_with_docker "--linux AppImage deb --arm64" "Linux ARM64"
        build_with_docker "--linux AppImage deb --x64" "Linux x64"
        build_with_docker "--win nsis portable --x64" "Windows x64"
        ;;
    *)
        echo -e "${RED}Unknown platform: $PLATFORM${NC}"
        echo ""
        echo "Usage: $0 [platform]"
        echo ""
        echo "Platforms:"
        echo "  linux-native  Build for host architecture (default)"
        echo "  linux         Build Linux x64"
        echo "  linux-arm     Build Linux ARM64"
        echo "  win           Build Windows x64 (via Wine)"
        echo "  all           Build all platforms"
        exit 1
        ;;
esac

# Generate manifest
generate_manifest

echo ""
echo -e "${GREEN}✅ Build completed!${NC}"
echo ""
echo -e "📁 Artifacts in: ${CYAN}$SCRIPT_DIR/desktop/release/${NC}"
echo ""
ls -lh "$SCRIPT_DIR/desktop/release/" 2>/dev/null | grep -v '\.blockmap\|\.yml\|builder-' || echo "No files yet"
echo ""
