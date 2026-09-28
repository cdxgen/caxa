# caxa

**Package Node.js applications into executable binaries.**

This is a high-performance fork of `caxa`. Version 4.0 replaces the Go runtime stub with a Rust stub that is about 5x smaller, cross-compiled for every target from a single host. Version 3.0 introduced portable Node bundling and zstd-compressed native payloads on top of the build/runtime improvements from the 2.x line. Version 3.1 focuses on binary size and startup latency: high-ratio zstd payloads by default, a leaner UPX strategy, and an on-disk V8 compile cache.

### What's new in v4.0

- **Rust runtime stub**: The self-extracting stub is rewritten in Rust (`stubs/`). It is 0.5–0.7 MB per target versus ~3 MB for the Go stub, so a slim `cdxgen` binary shrinks by ~2.5 MB with no UPX. The binary layout, footer, trailer and extraction-directory protocol are unchanged, so existing caches and custom packaging scripts keep working.
- **Lower extraction CPU**: The stub decompresses with the reference libzstd (statically linked). On a 46 MB `cdxgen` tree, user CPU during first-run extraction dropped by ~35% and cold start improved by ~5%. Warm starts are unchanged.
- **Static, cross-compiled stubs**: All seven stubs are built from one host with [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild). Linux stubs link musl statically; Windows stubs use the LLVM mingw ABI (no MSVC required).
- **Stripped Node runtime**: The bundled Node executable (and any shared libraries bundled with it) keeps only the symbols dynamic linking needs. Official Node releases ship their full symbol table: stripping takes the Linux x64 binary from 121 to 103 MB and the macOS arm64 one from 121 to 97 MB, about 2.5 MB of every binary's compressed size, and that many fewer bytes written on every cold start. On macOS the stripped copy is signed ad hoc. `--no-strip-node` keeps the symbols; see [Stripped Node Runtime](#stripped-node-runtime).
- **Parallel decode of large files**: Large files longer than 32 MiB, such as the bundled Node runtime and big plugins, are compressed in 32 MiB parts that the stub decodes on parallel threads, at about 1% of compression. Older stubs decode the same bytes as one stream; see [Payload Formats](#payload-formats).
- **Contributors need Rust instead of Go**: `npm run prepare` requires `rustup`, `zig` and `cargo-zigbuild`. Set `CAXA_STUBS=host` to build only the current platform's stub with plain `cargo`. `npm test` also checks the stub with `cargo fmt --check` and `cargo clippy -D warnings` (Rust 1.88 or newer, with the `rustfmt` and `clippy` components); `npm run format` formats both the packager and the stub.

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

1.  **Rust Stub**: A precompiled, statically linked Rust binary. If `--upx` is used, this section is compressed.
2.  **Magic Separator**: A specific byte sequence that allows the Stub to locate the start of the payload, even if the Stub itself was modified by UPX.
3.  **Payload**: A compressed TAR archive containing your application and the Node.js runtime. Native outputs default to zstd (level 19 + long-distance matching), while shell outputs use gzip. The bundled Node.js executable is stored uncompressed inside the archive, stripped of its symbol table; the outer zstd layer compresses it on disk without the per-launch decompression penalty of UPX.
4.  **Footer**: A JSON block near the end of the file.
5.  **Trailer**: A fixed-size binary trailer storing the payload offset, payload size, and footer size.

When executed, the Stub reads the trailer, seeks directly to the compressed payload, extracts it to a temporary directory (if not already cached), points `NODE_COMPILE_CACHE` at that directory, and executes the Node.js process with the arguments defined in the Footer. On the first run the V8 compile cache is populated; subsequent runs reuse it for faster startup.

#### Payload Formats

Native zstd payloads default to **v2**. The older single-stream layout is still produced with `--payload-format v1` and is the only format for gzip payloads (`.sh` outputs, `--compression gzip`).

**v1** — one zstd stream, trailer `CAXAIDX1` (32 bytes):

```text
[payload: single zstd stream of the tar][JSON footer][CAXAIDX1 trailer]
trailer = "CAXAIDX1" + LE u64 payload offset + u64 payload size + u64 footer size
```

**v2** — the tar is cut into frames that each end on tar entry boundaries (only the last frame carries the end-of-archive blocks), and every frame is compressed as an independent zstd frame:

```text
[payload: N concatenated zstd frames][frame index][JSON footer][CAXAIDX2 trailer]
trailer = "CAXAIDX2" + LE u64 payload offset, u64 payload size,
          u64 footer size, u64 index offset, u64 index size
index   = N entries of LE u64 compressed offset (relative to the payload start),
          u64 compressed size, u64 uncompressed size
```

Concatenated frames are themselves a valid zstd stream, so v1 tooling can decode the payload bytes; the index is what lets the runtime stub decode and extract frames in parallel with bounded memory. Frame count, per-frame uncompressed size and total uncompressed size are validated strictly when the binary starts, and corrupt or hostile indexes fail with an error before anything is extracted.

`CAXA_ZSTD_FRAME` (bytes, default 8388608, minimum 65536) and `CAXA_ZSTD_WORKERS` (threads, default: all cores, `0` = single stream) tune the v2 build; frame boundaries depend on these settings alone, never on scheduling, so identical inputs produce identical payload bytes.

Every regular file of at least 8 MiB (the bundled Node runtime, native plugins) gets a v2 frame of its own, laid out for in-place decoding: a pax header whose `comment` record is padded so that the file's data starts at a 64 KiB-aligned offset of the decoded frame, which ends right after the data. The footer lists these frames in an `aligned` array of `{ frame, size }`. On a cold start the Unix stub decodes each one straight into its file, as described for lazy members below, instead of into a buffer the size of the file, and such frames no longer count against the extraction's memory budget. tar readers ignore `comment` and older stubs ignore `aligned`, so they extract the same payload as before; Windows uses the buffered path.

An aligned frame longer than 32 MiB (a large hot file or a lazy member) is compressed in **parts**: equal slices of the decoded frame, each a multiple of 64 KiB and the last one shorter, compressed as independent zstd frames and stored one after another in the frame's index entry. The footer entry gains `parts`, a list of `[compressed size, uncompressed size]` pairs. The stub decodes the parts on parallel threads, each part straight into its own range of the file on Unix and of the frame buffer on Windows; the prefetcher decodes them on its one thread. A part costs about 1% of compression at this size, and the bundled Node runtime, at around 100 MB, gets three or four. Concatenated zstd frames are one valid zstd stream, so tar tooling and stubs that predate `parts` decode the entry exactly as before. `CAXA_ZSTD_PART` (bytes, default 33554432, minimum 65536, rounded up to a multiple of 64 KiB) sets the part size, and `0` keeps every frame whole. Parts depend on the frame and this setting alone, so payload bytes stay deterministic.

#### Lazy Members

Large executables that most runs never touch (optional plugins, for example) can be marked lazy with `--lazy <glob>` (repeatable, relative to `--input`) or the `CAXA_LAZY` environment variable (newline- or comma-separated globs, appended to the flag values). Until its first run a lazy member is a placeholder, so it must only ever be executed: anything that reads, hashes, copies or loads it before then gets the placeholder's bytes. Only native executables (ELF, Mach-O executables and universal binaries, PE) and `#!` scripts with an exec bit qualify (Windows records no exec bits, so on a Windows build host the header alone decides); data files that merely carry an exec bit and shared libraries (`.so`, `.dylib`, `.dll`, `.node`) are packed normally, and every such match is listed in the build output. A `--lazy` pattern that matches no executable fails the build; a `CAXA_LAZY` pattern that matches none is only reported, since one environment is usually applied to several targets. Lazy members need the v2 payload format.

Lazy members leave the hot tar stream and go at the end of the v2 payload, sorted by path, one member (with its pax/long-name records) per frame. Each frame starts with a pax header whose `comment` record is padded so that the member's data begins at a 64 KiB-aligned offset of the decoded frame; tar readers ignore `comment`, so any tar reader, including older stubs, extracts the frame unchanged. The footer gains a `lazy` array of `{ path, frame, mode, size, sha256 }`, where `sha256` is over the frame's compressed bytes, plus `parts` for a member long enough to be split (see [Payload Formats](#payload-formats)). The trailer and index are unchanged, so a stub that predates lazy members ignores the field and extracts everything.

With `--lazy-auto` (or the environment form `CAXA_LAZY_AUTO=1`) every native executable of at least 1 MiB becomes a lazy member, on top of any `--lazy`/`CAXA_LAZY` matches — no globs to maintain. `#!` scripts are never auto-selected: interpreters read them (`node cli.js`, `sh run.sh`, `require()`), and npm sets an exec bit on every package `bin` script, so they need an explicit `--lazy` glob. Every `{{caxa}}/…` file the packaged command names stays eager (a placeholder would have to exec itself to start the app), and so does the bundled Node runtime, which never passes through the file collection to begin with. Auto-selected members are marked `(auto, <size> bytes)` in the build output's lazy member list.

On a cold start the stub extracts every other frame and writes a placeholder at each member path, with the member's mode: a copy of the stub (the bytes before the separator) followed by `[placeholder JSON][LE u64 JSON length]["CAXALZY1"]`. The stub runs the app with `CAXA_EXECUTABLE` set to the absolute path of the caxa binary. The first time something executes a placeholder, it finds the caxa binary (`CAXA_EXECUTABLE`, then the path recorded at extraction), checks that its identifier and frame index entry match, and decodes the frame straight into a temp file next to the placeholder: the temp file is preallocated and memory-mapped under the aligned data offset, and zstd streams into the mapping, so no buffer the size of the member is ever allocated. A split member's parts decode on parallel threads instead, each into its own range of the mapping, and are hashed in order from the very buffers that were decoded. Only when the frame's sha256 (hashed as it streams in), its decoded size and its single regular entry (path, type, size and data offset) all match is the temp file renamed over the placeholder. On macOS, which kills a signed binary whose pages were written through a writable mapping, the verified bytes are first written once more, with `write()`, into a fresh temp file, and that one is renamed. A frame without the aligned layout, or a filesystem that cannot preallocate and map the file, takes the buffered path: verify the sha256, decode into memory, check the entry, write the temp file, rename. It then execs the member with the original argv and environment. Concurrent first runs each write their own temp file, so no partial file is ever executed. If no valid caxa binary is found (for example, it was moved and `CAXA_EXECUTABLE` is not set), the placeholder exits with one line naming the member and identifier; running the caxa binary again, or deleting `apps/<id>`, fixes it.

On Windows a running exe cannot be replaced in place, so lazy members are a no-op there: their frames are extracted eagerly and no placeholder is written.

#### Background Prefetch (Unix)

So that a cold start does not leave every lazy member as a placeholder until each one is first used, the stub spawns one detached **prefetcher** — a copy of itself — just before the app starts. The prefetcher materializes the members that are still placeholders, one at a time at low priority (`nice 10`), in its own process group with all stdio on `/dev/null` and every other inherited descriptor closed, so a caller waiting for EOF on a pipe it passed to the app does not wait for the prefetcher. Short commands therefore return immediately while the work continues in the background, and later spawns usually find real files. It runs alongside the app with a heap of about a megabyte: members decode in place, so their bytes live only in the page cache (a member that falls back to the buffered path uses one pair of buffers, reused for every such member).

A prefetcher runs only when the layout has lazy members, `CAXA_PREFETCH` is not `0`, the app dir holds at least one placeholder of this binary's identifier, and no live prefetcher exists (a pid lock at `locks/<id>/<attempt>.prefetch`, replaced when stale by mtime or when its writer is gone). When the last member is done it writes a `.caxa-prefetched` marker in the app dir and removes its lock; a warm start that sees the marker skips the scan entirely. The prefetcher is best effort: any error — including the cache being deleted mid-run — makes it clean up and exit 0 silently. It never touches a real file or a placeholder of another identifier, and racing first-runs are safe by the same temp-file-and-rename argument as the on-demand path. Every writer holds an flock on its temp file until the rename; the prefetcher removes leftover temp files only when their writer pid is gone and their lock is free. Windows has no placeholders, so it never spawns or runs a prefetcher.

Set `CAXA_PREFETCH=0` to keep the pure on-demand behaviour: no prefetcher, no lock, no marker.

#### Stripped Node Runtime

The Node executable caxa bundles is a copy of the one running the build, and official Node releases ship with their full symbol table: about 18 MB of the 121 MB Linux x64 binary, and 24 MB on macOS arm64. Nothing reads it at run time, yet every cold start writes it to disk, so caxa strips the copy (and any non-system shared library it bundles with it):

- **Linux**: `strip` (GNU or LLVM binutils), `--strip-all` for the executable and `--strip-unneeded` for libraries. The dynamic symbol table that native addons link against stays.
- **macOS**: `strip -x`, which drops local symbols and keeps every global one; addons still find all of Node's exports. Stripping invalidates the Node.js Foundation's signature, and arm64 macOS refuses to run a binary whose signature is invalid, so the copy is then signed ad hoc with the original's identifier, entitlements and hardened-runtime flag, and verified with `codesign --verify --strict`.
- **Windows**: nothing to strip; Windows builds keep their symbols in separate `.pdb` files.

The price is the names of Node's internal C++ functions in native stack traces, crash reports and `--prof` output. `--no-strip-node` (or `stripNode: false`) bundles Node byte for byte instead. When stripping fails, for example because `strip` or `codesign` is missing on the build host, caxa warns and bundles the unstripped copy. Both tools are deterministic, so identical inputs still produce identical binaries. `binary-metadata.json` marks a stripped runtime with a `cdx:caxa:stripped` property on the Node component, since its hash, and on macOS its signature, no longer match the Node release.

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
  --no-strip-node                        Bundle the Node.js executable with its symbol table (by default it is stripped;
                                         on macOS it is then signed ad hoc). See "Stripped Node Runtime".
  -s, --stub <path>                      Path to a custom stub.
  --identifier <identifier>              Build identifier used for the extraction path.
  -B, --no-remove-build-directory        [Legacy] Ignored in v2 due to streaming build architecture.
  -m, --uncompression-message <message>  A message to show to the user while uncompressing.
  -c, --compression <type>               Payload compression: native outputs default to 'zstd'; shell outputs support 'gzip' only.
  --payload-format <format>              Payload format: 'v1' (single stream) or 'v2' (frames with an index, default for native
                                         zstd payloads). 'v2' requires zstd and native outputs.
  --lazy <glob>                          Executables (relative to --input) to extract on first use instead of on a cold
                                         start. Repeatable; requires the v2 payload format. See "Lazy Members".
  --lazy-auto                            Also make every native executable of at least 1 MiB a lazy member (files the
                                         command names stay eager). See "Lazy Members".
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
| `CAXA_ZSTD_WORKERS`          | Build-time only. Worker threads compressing zstd payload frames (default: all cores). `0` restores the single-stream payload. |
| `CAXA_ZSTD_FRAME`            | Build-time only. Frame size in bytes for chunked zstd payloads (default: 8388608, minimum: 65536).                            |
| `CAXA_ZSTD_PART`             | Build-time only. Part size in bytes for long aligned frames (default: 33554432, minimum: 65536). `0` keeps them whole.         |
| `CAXA_LAZY`                  | Build-time only. Newline- or comma-separated lazy-member globs, appended to `--lazy`. Patterns without matches only warn.     |
| `CAXA_LAZY_AUTO`             | Build-time only. `1` turns `--lazy-auto` on without a new flag.                                                               |
| `CAXA_PREFETCH`              | Run-time only. `0` disables the background prefetcher of lazy members. Anything else keeps it on (the default).                |
| `CAXA_PREFETCH_APP`          | Internal. Set by the stub for its own prefetcher process; never visible to the app.                                            |
| `CAXA_EXECUTABLE`            | Set by the stub for the app: absolute path of the caxa binary. Lazy-member placeholders read it to find the payload.          |
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
