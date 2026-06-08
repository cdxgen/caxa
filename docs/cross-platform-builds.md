# Cross-Platform & Musl standalone builds with `caxa`

By default, `caxa` bundles the currently running Node.js executable (resolved via `process.execPath`). This makes it easy to package applications for the local host environment, but presents challenges when cross-compiling or building for distinct runtime environments—specifically when packaging for Musl-based distributions (like Alpine Linux) vs. Glibc-based distributions (like Ubuntu/Debian).

This document explains the technical details and provides example scripts and workflows to achieve fully self-contained standalone builds.

---

## The Alpine/Musl Dynamically Linked Node.js Problem

If you run `caxa` inside a standard Alpine Linux Docker container after installing Node.js via the system package manager (`apk add nodejs`), `caxa` will capture the system Node.js. 

However, Alpine's default Node.js package is **dynamically linked** to system libraries (`libstdc++`, `libsimdjson`, `libada`, `libsqlite3`, `libcares`, etc.). Because `caxa` excludes standard library directories like `/usr/lib` (to prevent bundling standard system dependencies), the packaged standalone binary will be missing these shared libraries. 

When run on a clean Alpine system, the executable will fail with errors like:
```text
Error loading shared library libstdc++.so.6: No such file or directory
Error loading shared library libsimdjson.so.23: No such file or directory
```

### The Solution: Using Precompiled Static/Musl Node.js Binaries

To build a fully self-contained standalone binary for Musl environments, you should use the **official/unofficial precompiled Node.js musl binary tarball** (which statically compiles its internal dependencies, leaving only a dependency on the host's `libstdc++` and libc). 

You can force `caxa` to bundle this specific version by prepending the downloaded Node.js binary directory to your `PATH` before running `caxa`.

---

## Build Automation Script (`build-musl.sh`)

You can use the following script to automate downloading the correct static Node.js Musl binary and executing `caxa` to build your standalone package:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Configuration
VERSION="24.16.0"      # The Node.js version you want to target
ARCH="${1:-amd64}"     # amd64 or arm64
OUTPUT="${2:-my-app}"  # Name of output binary

# Map architecture names to Node.js release naming
NODE_ARCH="x64"
if [[ "$ARCH" == "arm64" || "$ARCH" == "aarch64" ]]; then
  NODE_ARCH="arm64"
fi

echo "Installing build prerequisites..."
apk add --no-cache curl xz bash libstdc++

echo "Downloading precompiled Musl Node.js $VERSION for $NODE_ARCH..."
curl -fsSL -O "https://unofficial-builds.nodejs.org/download/release/v${VERSION}/node-v${VERSION}-linux-${NODE_ARCH}-musl.tar.xz"

echo "Extracting tarball..."
tar -xJf "node-v${VERSION}-linux-${NODE_ARCH}-musl.tar.xz"
export PATH="$(pwd)/node-v${VERSION}-linux-${NODE_ARCH}-musl/bin:$PATH"

echo "Verified Node.js version to package:"
node --version

echo "Running caxa to build standalone binary..."
pnpm --package=@cdxgen/caxa dlx caxa \
  --input "." \
  --output "$OUTPUT" \
  -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/dist/index.js"

echo "Successfully packaged standalone binary: $OUTPUT"
```

---

## GitHub Actions Matrix Workflow

This GitHub Actions workflow demonstrates how to compile native binaries for Darwin (Intel/Apple Silicon) and Linux (GNU/Musl) using a build matrix.

```yaml
name: Standalone Binary Builds

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  binaries:
    strategy:
      fail-fast: false
      matrix:
        os: [ darwin, linux ]
        arch: [ amd64, arm64 ]
        libc: [ gnu, musl ]
        exclude:
          - os: darwin
            libc: musl
        include:
          - os: darwin
            arch: amd64
            runner: macos-15-intel
          - os: darwin
            arch: arm64
            runner: macos-15
          - os: linux
            arch: amd64
            runner: ubuntu-24.04
          - os: linux
            arch: arm64
            runner: ubuntu-24.04-arm

    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js (for Darwin/Linux GNU)
        if: ${{ matrix.libc != 'musl' }}
        uses: actions/setup-node@v4
        with:
          node-version: "24"

      # GNU / Darwin builds run directly on the host runner
      - name: Build Standalone (Glibc / macOS)
        if: ${{ matrix.libc != 'musl' }}
        run: |
          npx --package=@cdxgen/caxa caxa \
            --input "." \
            --output "my-app-${{ matrix.os }}-${{ matrix.arch }}" \
            -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/dist/index.js"

      # Musl builds are containerized using Alpine Linux and a statically linked Node.js
      - name: Get host user info
        id: user_info
        if: ${{ matrix.libc == 'musl' }}
        run: echo "user=$(id -u):$(id -g)" >> $GITHUB_OUTPUT

      - name: Build Standalone (Linux Musl)
        if: ${{ matrix.libc == 'musl' }}
        run: |
          docker run --rm \
            -v "${{ github.workspace }}:${{ github.workspace }}" \
            -w "${{ github.workspace }}" \
            alpine:3.21 \
            sh -c "apk add --no-cache curl xz bash libstdc++ && \
                   NODE_ARCH=\$(if [ '${{ matrix.arch }}' = 'amd64' ]; then echo 'x64'; else echo 'arm64'; fi) && \
                   curl -fsSL -O https://unofficial-builds.nodejs.org/download/release/v24.16.0/node-v24.16.0-linux-\${NODE_ARCH}-musl.tar.xz && \
                   tar -xJf node-v24.16.0-linux-\${NODE_ARCH}-musl.tar.xz && \
                   export PATH=\"\$(pwd)/node-v24.16.0-linux-\${NODE_ARCH}-musl/bin:\$PATH\" && \
                   npx --package=@cdxgen/caxa caxa \
                     --input '.' \
                     --output 'my-app-linux-${{ matrix.arch }}-musl' \
                     -- '{{caxa}}/node_modules/.bin/node' '{{caxa}}/dist/index.js' && \
                   chown -R ${{ steps.user_info.outputs.user }} ."

      - name: Upload Standalone Artifact
        uses: actions/upload-artifact@v4
        with:
          name: standalone-${{ matrix.os }}-${{ matrix.arch }}-${{ matrix.libc }}
          path: my-app-*
```
