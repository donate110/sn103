#!/usr/bin/env bash
# Download pre-built TLSNotary prover & verifier binaries for Djinn Protocol.
#
# Usage:
#   ./install-tlsn-tools.sh              # Install to /usr/local/bin
#   ./install-tlsn-tools.sh ~/.local/bin  # Install to custom directory
#
# Supports: Linux x86_64, Linux aarch64, macOS x86_64, macOS aarch64
# Falls back to building from source if no pre-built binary is available.

set -euo pipefail

INSTALL_DIR="${1:-/usr/local/bin}"
REPO="Djinn-Inc/djinn"
TAG="${TLSN_TOOLS_VERSION:-latest}"

# Detect platform
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$OS" in
    linux)  PLATFORM="linux" ;;
    darwin) PLATFORM="macos" ;;
    *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

case "$ARCH" in
    x86_64|amd64) ARCH="x86_64" ;;
    aarch64|arm64) ARCH="aarch64" ;;
    *)      echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

ASSET_PREFIX="djinn-tlsn-tools-${PLATFORM}-${ARCH}"

echo "Platform: ${PLATFORM}-${ARCH}"
echo "Install directory: ${INSTALL_DIR}"

# Resolve latest release tag
if [ "$TAG" = "latest" ]; then
    TAG=$(curl -sL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | cut -d'"' -f4)
    if [ -z "$TAG" ]; then
        echo "Could not determine latest release. Falling back to building from source."
        SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
        TOOLS_DIR="${SCRIPT_DIR}/../tlsn-tools"
        if [ -f "${TOOLS_DIR}/build.sh" ]; then
            echo "Building from source..."
            cd "$TOOLS_DIR" && bash build.sh
            cp target/release/djinn-tlsn-prover target/release/djinn-tlsn-verifier target/release/djinn-tlsn-notary "$INSTALL_DIR/"
            echo "Installed (built from source):"
            ls -la "$INSTALL_DIR/djinn-tlsn-prover" "$INSTALL_DIR/djinn-tlsn-verifier" "$INSTALL_DIR/djinn-tlsn-notary"
            exit 0
        fi
        echo "No tlsn-tools source found. Please build manually."
        exit 1
    fi
fi

echo "Release: ${TAG}"

# Download
ASSET_NAME="${ASSET_PREFIX}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}"

echo "Downloading ${URL}..."
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if ! curl -sL --fail -o "${TMPDIR}/${ASSET_NAME}" "$URL"; then
    echo "Download failed. Pre-built binary may not be available for ${PLATFORM}-${ARCH}."
    echo "Falling back to building from source..."
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    TOOLS_DIR="${SCRIPT_DIR}/../tlsn-tools"
    if [ -f "${TOOLS_DIR}/build.sh" ]; then
        cd "$TOOLS_DIR" && bash build.sh
        mkdir -p "$INSTALL_DIR"
        cp target/release/djinn-tlsn-prover target/release/djinn-tlsn-verifier target/release/djinn-tlsn-notary "$INSTALL_DIR/"
        echo "Installed (built from source):"
        ls -la "$INSTALL_DIR/djinn-tlsn-prover" "$INSTALL_DIR/djinn-tlsn-verifier" "$INSTALL_DIR/djinn-tlsn-notary"
        exit 0
    fi
    echo "No tlsn-tools source found and no pre-built binary available."
    exit 1
fi

# Extract & install
mkdir -p "$INSTALL_DIR"
tar xzf "${TMPDIR}/${ASSET_NAME}" -C "${TMPDIR}"
cp "${TMPDIR}/djinn-tlsn-prover" "${TMPDIR}/djinn-tlsn-verifier" "${TMPDIR}/djinn-tlsn-notary" "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/djinn-tlsn-prover" "$INSTALL_DIR/djinn-tlsn-verifier" "$INSTALL_DIR/djinn-tlsn-notary"

echo "Installed:"
ls -la "$INSTALL_DIR/djinn-tlsn-prover" "$INSTALL_DIR/djinn-tlsn-verifier" "$INSTALL_DIR/djinn-tlsn-notary"
echo ""
echo "Verify:"
"$INSTALL_DIR/djinn-tlsn-prover" --help 2>&1 | head -1
"$INSTALL_DIR/djinn-tlsn-verifier" --help 2>&1 | head -1
"$INSTALL_DIR/djinn-tlsn-notary" --help 2>&1 | head -1
