# caxa

**Package Node.js applications into executable binaries.**

This is a high-performance fork of `caxa`. Version 4.0 replaces the Go runtime stub with a Rust stub that is about 5x smaller, cross-compiled for every target from a single host. Version 3.0 introduced portable Node bundling and zstd-compressed native payloads on top of the build/runtime improvements from the 2.x line. Version 3.1 focuses on binary size and startup latency: high-ratio zstd payloads by default, a leaner UPX strategy, and an on-disk V8 compile cache.

### What's new in v4.0

- **Rust runtime stub**: The self-extracting stub is rewritten in Rust (`stubs/`). It is 0.5–0.7 MB per target versus ~3 MB for the Go stub, so a slim `cdxgen` binary shrinks by ~2.5 MB with no UPX. The binary layout, footer, trailer and extraction-directory protocol are unchanged, so existing caches and custom packaging scripts keep working.
- **Lower extraction CPU**: The stub decompresses with the reference libzstd (statically linked). On a 46 MB `cdxgen` tree, user CPU during first-run extraction dropped by ~35% and cold start improved by ~5%. Warm starts are unchanged.
- **Static, cross-compiled stubs**: All seven stubs are built from one host with [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild). Linux stubs link musl statically; Windows stubs use the LLVM mingw ABI (no MSVC required).
- **Contributors need Rust instead of Go**: `npm run prepare` requires `rustup`, `zig` and `cargo-zigbuild`. Set `CAXA_STUBS=host` to build only the current platform's stub with plain `cargo`.

### What's new in v3.1

- **High-ratio zstd by default**: Native payloads are now compressed at zstd level 19 with long-distance matching enabled. On real `cdxgen` payloads this shrinks binaries by roughly 20% versus the previous default at no runtime cost (extraction speed is unchanged). Build-time CPU is higher; tune with `CAXA_ZSTD_LEVEL` if you need faster builds.
- **Leaner UPX strategy**: `--upx` now compresses only the small runtime stub. The bundled Node.js executable is intentionally left uncompressed — UPX had to decompress the whole runtime into memory on every launch (slower cold start, higher RSS) and broke code signing / notarization while triggering antivirus false positives. The zstd payload already compresses the runtime on disk.
- **V8 compile cache**: The stub points `NODE_COMPILE_CACHE` at the reused extraction directory, so V8 bytecode is persisted after the first run and reused on subsequent launches (measurably faster warm starts). Disable with `CAXA_DISABLE_COMPILE_CACHE=1` or override with your own `NODE_COMPILE_CACHE`.
- **Fewer extraction syscalls**: The runtime stub deduplicates directory creation while unpacking, avoiding a redundant `mkdir` per file across large `node_modules` trees.

See [docs/performance.md](docs/performance.md) for benchmarks and the design rationale behind these changes.

### Key Improvements in v3

- **Streaming Builds**: Eliminated the intermediate build directory. Files are streamed directly from the source to the compressed archive, halving disk I/O during the packaging process.
- **Batch Builds**: Build multiple native binaries from the same input tree in a single pass. This is ideal for projects like `cdxgen` that publish several command variants from one package.
- **Portable Node Bundling**: caxa now bundles the Node runtime together with non-system shared-library dependencies and a launcher shim when needed. This makes binaries portable across machines even when the source Node installation came from Homebrew or another dynamically-linked package manager.
- **zstd Native Payloads**: Native stub outputs default to `tar + zstd`, compressed at level 19 with long-distance matching for the smallest possible binaries. Legacy gzip payloads remain supported, and shell stub outputs continue to use gzip. Set `CAXA_ZSTD_LEVEL` to trade compression ratio for build speed.
- **Stub-only UPX**: When the `--upx` flag is used, caxa compresses the runtime stub only. The bundled Node.js executable is left uncompressed so the runtime memory-maps directly at launch (fast cold start) and stays compatible with code signing and antivirus.
- **High-Performance Decompression**: The runtime stub decompresses zstd with the reference libzstd and gzip with `miniz_oxide`. This reduces startup latency and memory overhead for large self-extracting binaries.
- **Trailer-Based Startup**: Native binaries now end with a fixed-size trailer that stores payload offsets and footer size, allowing the runtime stub to seek directly to the compressed payload instead of loading the whole executable into memory first.
- **Parallel Extraction & Smart Buffering**: The runtime stub now utilizes a worker pool to extract small files (like `node_modules`) concurrently, maximizing disk I/O saturation. Large files (>1MB) are streamed synchronously to prevent memory spikes.
- **Atomic Extraction**: Implemented a lock-based extraction mechanism in the runtime stub. This prevents corruption if the application process is killed during the initial extraction.
- **SBOM Ready**: Automatically generates a `binary-metadata.json` sidecar file containing a full dependency graph (components and relationship tree). This facilitates high-fidelity SBOM generation using tools like [cdxgen](https://github.com/cdxgen/cdxgen).

### How it Works

caxa does not compile Node.js from source or mess with V8 internals. It works by creating a self-extracting executable with a specific structure.

#### Binary Anatomy

Whether you use UPX or not, the final binary structure follows this layout:

```text
+-----------------------------+
|         Rust Stub           |  <-- The executable entry point.
| (Native Code / UPX Packed)  |      Responsible for bootstrapping.
+-----------------------------+
|       \nCAXACAXACAXA\n      |  <-- Magic Separator (Plaintext).
+-----------------------------+
|     Application Payload     |  <-- Your project files + Node.js runtime.
|     (tar + zstd / gzip)     |      Streamed directly to disk at runtime.
+-----------------------------+
|        JSON Config          |  <-- Metadata, Command arguments, & Build ID.
+-----------------------------+
|      Fixed-size Trailer     |  <-- Payload offset / size lookup for fast startup.
+-----------------------------+
```

1.  **Rust Stub**: A pre-compiled, statically linked Rust binary. If `--upx` is used, this section is compressed.
2.  **Magic Separator**: A specific byte sequence that allows the Stub to locate the start of the payload, even if the Stub itself was modified by UPX.
3.  **Payload**: A compressed TAR archive containing your application and the Node.js runtime. Native outputs default to zstd (level 19 + long-distance matching), while shell outputs use gzip. The bundled Node.js executable is stored uncompressed inside the archive; the outer zstd layer compresses it on disk without the per-launch decompression penalty of UPX.
4.  **Footer**: A JSON block near the end of the file.
5.  **Trailer**: A fixed-size binary trailer storing the payload offset, payload size, and footer size.

When executed, the Stub reads the trailer, seeks directly to the compressed payload, extracts it to a temporary directory (if not already cached), points `NODE_COMPILE_CACHE` at that directory, and executes the Node.js process with the arguments defined in the Footer. On the first run the V8 compile cache is populated; subsequent runs reuse it for faster startup.

### Features

- **Cross-Platform**: Supports Windows, macOS (Intel & ARM), and Linux (Intel, ARM64, ARMv6/7).
- **Zero Config**: No need to manually define assets.
- **Native Modules**: Fully supports projects with native C++ bindings (`.node` files).
- **No Magic**: Does not patch `require()`. Filesystem access works exactly as it does in a standard Node.js environment.
- **Portable Runtime Shims**: Bundled Node launchers automatically configure runtime library lookup paths when the host Node executable depends on non-system dynamic libraries.
- **Optional UPX Stub Compression**: Optional post-build compression with [UPX](https://upx.github.io/). This compresses the runtime stub only; the bundled Node.js executable is left uncompressed to preserve fast startup and code-signing compatibility.

### Installation

```console
$ npm install --save-dev @cdxgen/caxa
```

### Usage

#### 1. Prepare the Project

Ensure your project is built (e.g., TypeScript compiled to JavaScript) and dependencies are installed.

```bash
npm ci
npm run build
```

#### 2. Run caxa

Call `caxa` from the command line:

```console
$ npx caxa --input "." --output "my-app" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/dist/index.js"
```

By default, native binaries now use zstd payload compression. To force gzip instead:

```console
$ npx caxa --input "." --output "my-app" --compression gzip -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/dist/index.js"
```

To create a smaller binary, use the --upx flag. You must have upx installed on your system.

```console
$ npx caxa --input "." --output "my-app" --upx --upx-args="--best" -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/dist/index.js"
```

pnpm is also supported. Below is how `cdxgen` SEA binaries gets created.

```
$ pnpm --package=@cdxgen/caxa dlx caxa --input . --output cdxgen -- "{{caxa}}/node_modules/.bin/node" "{{caxa}}/bin/cdxgen.js"
```

For multi-command projects, use batch mode to build several native outputs while creating the payload only once:

```json
[
  {
    "output": "cdxgen",
    "metadataFile": ".cdxgen-metadata.json",
    "command": ["{{caxa}}/node_modules/.bin/node", "{{caxa}}/bin/cdxgen.js"]
  },
  {
    "output": "cdx-audit",
    "metadataFile": ".cdx-audit-metadata.json",
    "command": ["{{caxa}}/node_modules/.bin/node", "{{caxa}}/bin/audit.js"]
  }
]
```

```console
$ pnpm --package=@cdxgen/caxa dlx caxa --input . --targets-file caxa-targets.json
```

### CLI Reference

```text
Usage: caxa [options] <command...>

Arguments:
  command                                The command to run. Paths must be absolute.
                                         The '{{caxa}}' placeholder is substituted for the extraction directory.
                                         The 'node' executable is available at '{{caxa}}/node_modules/.bin/node'.

Options:
  -i, --input <input>                    [Required] The input directory to package.
  -o, --output <output>                  [Required] The path where the executable will be produced.
                                         On Windows, must end in '.exe'.
  --targets-file <path>                  JSON file describing multiple native outputs to build from one payload.
  -F, --no-force                         Don't overwrite output if it exists.
  -e, --exclude <path...>                Paths to exclude from the build (glob patterns).
  -N, --no-include-node                  Don't copy the Node.js executable into the package.
  -s, --stub <path>                      Path to a custom stub.
  --identifier <identifier>              Build identifier used for the extraction path.
  -B, --no-remove-build-directory        [Legacy] Ignored in v2 due to streaming build architecture.
  -m, --uncompression-message <message>  A message to show to the user while uncompressing.
  -c, --compression <type>               Payload compression: native outputs default to 'zstd'; shell outputs support 'gzip' only.
  --upx                                  Compress the runtime stub with UPX (the bundled Node.js is left uncompressed).
  --upx-args <args...>                   Arguments to pass to UPX (e.g., '--best --lzma').
  -V, --version                          output the version number
  -h, --help                             display help for command
```

### Programmatic Usage

You can invoke caxa directly from TypeScript or JavaScript build scripts.

```typescript
import caxa from "@cdxgen/caxa";

(async () => {
  await caxa({
    input: ".",
    output: "bin/my-app",
    command: [
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/dist/index.js",
      "--custom-flag",
    ],
    exclude: ["*.log", "tmp/**"],
    upx: true,
    upxArgs: ["--best"],
  });
})();
```

### Runtime Behavior

#### Temporary Directory

By default, the application extracts to the system temporary directory (`os.tmpdir()` joined with `caxa`).

To override this location (e.g., for containerized environments with read-only `/tmp`), set the environment variable `CAXA_TEMP_DIR`:

```bash
export CAXA_TEMP_DIR=/var/opt/my-app
./my-app
```

#### V8 Compile Cache

On the first launch the stub creates a `.node-compile-cache` directory inside the extraction directory and points Node's `NODE_COMPILE_CACHE` at it, so V8 bytecode is compiled once and reused on later runs. This is transparent and requires no configuration.

- To disable it entirely: `export CAXA_DISABLE_COMPILE_CACHE=1`
- To store the cache elsewhere (e.g. a writable, persistent path): set your own `NODE_COMPILE_CACHE`, which the stub always respects.

Requires the bundled runtime to be Node.js 22 or newer; it is ignored otherwise and harmless for non-Node runtimes.

#### Environment Variables

| Variable                     | Effect                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CAXA_TEMP_DIR`              | Overrides the extraction root (default: `os.tmpdir()/caxa`).                                                                  |
| `CAXA_ZSTD_LEVEL`            | Build-time only. Overrides the default zstd compression level (19). Lower values build faster at the cost of a larger binary. |
| `NODE_COMPILE_CACHE`         | If set, used verbatim as the V8 compile-cache directory for the child process.                                                |
| `CAXA_DISABLE_COMPILE_CACHE` | If set, the stub does not configure a compile cache.                                                                          |

#### Supply Chain Security

Every build produces a `binary-metadata.json` file alongside the executable. This file captures the full dependency graph of the packaged application, structured to align with SBOM standards.

Example `binary-metadata.json`:

```json
{
  "components": [
    {
      "group": "",
      "name": "my-app",
      "version": "1.0.0",
      "purl": "pkg:npm/my-app@1.0.0"
    },
    {
      "group": "",
      "name": "commander",
      "version": "12.0.0",
      "purl": "pkg:npm/commander@12.0.0"
    }
  ],
  "dependencies": [
    {
      "ref": "pkg:npm/my-app@1.0.0",
      "dependsOn": ["pkg:npm/commander@12.0.0"]
    }
  ]
}
```

### Anti-Features

- **No Source Hiding**: This is a packaging tool, not an obfuscator. The source code is extracted to the disk at runtime.
- **No Cross-Compilation**: The machine running `caxa` must have the same architecture/OS as the target if you want to bundle the _correct_ Node.js binary. You cannot bundle a Windows Node.js executable from a macOS machine (unless you provide it manually via custom scripts). See [docs/cross-platform-builds.md](docs/cross-platform-builds.md) for a guide on cross-compiling for Musl (Alpine Linux) using static Node.js binaries.
