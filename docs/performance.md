# Binary size & startup performance

This document describes the size- and startup-oriented architecture introduced in
caxa 3.1, and records the design exploration behind it (including an idea that was
evaluated and rejected). Benchmarks below were captured on macOS (Apple Silicon,
Node.js 24) packaging a real production `cdxgen` staging tree (~47 MB input).

## Summary of 3.1 changes

| Change                                     | Layer                          | Effect                                   |
| ------------------------------------------ | ------------------------------ | ---------------------------------------- |
| zstd level 19 + long-distance matching     | build (`source/index.mts`)     | ~20% smaller native binaries             |
| UPX applied to the Go stub only            | build                          | Faster cold start, signing/AV compatible |
| Deduplicated `mkdir` during extraction     | runtime stub (`stubs/stub.go`) | Fewer syscalls unpacking `node_modules`  |
| `NODE_COMPILE_CACHE` in the reused app dir | runtime stub                   | ~8% faster warm starts                   |

## 1. High-ratio zstd payloads

Payloads are written once at build time and read on every launch, so caxa favours
aggressive compression. Native outputs now default to zstd level 19 with
`ZSTD_c_enableLongDistanceMatching`, which is well suited to `node_modules` trees
that contain many near-duplicate files across packages.

Extraction speed is unaffected by the compression level — only build-time CPU
increases. The level is configurable via the `CAXA_ZSTD_LEVEL` environment
variable for builds that prioritise speed over size.

Measured build-time/size trade-off (cdxgen payload):

| Level                | Build time | Binary size |
| -------------------- | ---------- | ----------- |
| 3 (previous default) | 4.8 s      | 35.9 MB     |
| 9                    | 5.5 s      | 33.1 MB     |
| 12                   | 6.8 s      | 32.7 MB     |
| 15                   | 13.7 s     | 32.4 MB     |
| **19 (default)**     | 34.7 s     | **29.3 MB** |

Against the pre-3.1 baseline binary (38.4 MB) the default level 19 build is
**20% smaller (30.8 MB)**. Long-distance matching alone accounts for part of the
win even at low levels.

## 2. Stub-only UPX

Earlier versions optionally UPX-compressed the bundled Node.js executable. This
was reverted because UPX must decompress the entire runtime into memory on every
launch — adding cold-start latency and resident memory — and because a
UPX-modified `node` breaks macOS code signing / notarization and frequently
triggers antivirus false positives on Windows. A UPX-compressed executable also
compresses poorly inside the outer zstd layer (it is already compressed), so the
on-disk savings were marginal.

`--upx` now compresses only the small (~3 MB) Go stub. The Node.js runtime is
stored uncompressed inside the tar and compressed once by the outer zstd layer,
so it can be memory-mapped directly at launch.

## 3. Extraction: deduplicated directory creation

The runtime stub extracts the payload with a worker pool. Previously every file,
symlink, and large-file entry issued its own `os.MkdirAll` for the parent
directory. Because `node_modules` trees have thousands of files sharing a handful
of parent directories, the stub now records created directories in a `sync.Map`
and skips the redundant syscalls. `MkdirAll` remains idempotent, so the rare
duplicate under a race is harmless.

## 4. V8 compile cache

Node.js 22+ can persist compiled V8 bytecode to disk via `NODE_COMPILE_CACHE`.
caxa already reuses a content-addressed extraction directory across runs, which is
the natural place to keep this cache. The stub sets
`NODE_COMPILE_CACHE=<appDir>/.node-compile-cache` for the child process unless the
caller already set `NODE_COMPILE_CACHE`, or opted out with
`CAXA_DISABLE_COMPILE_CACHE`.

Effect (cdxgen `--version`, median of warm runs):

| Configuration                   | Warm start |
| ------------------------------- | ---------- |
| Compile cache disabled          | 548 ms     |
| Compile cache enabled (default) | 504 ms     |

That is roughly an 8% improvement for a light command; heavier commands load a
larger module graph and benefit more. The first run pays a one-time cost to write
the cache (~6.9 MB for cdxgen) and the cache lives inside the extraction
directory, so it survives for as long as the extracted app is cached.

## Rejected: V8 startup snapshots / SEA

Node's `--build-snapshot` (and single-executable applications) can embed a
pre-initialized heap to skip module parsing at startup. It was evaluated for
bundling cdxgen's hot module graph but is **not viable** here:

- The snapshot builder only accepts a CommonJS entry point. cdxgen (and most
  modern targets) ship as ESM (`"type": "module"`); pointing `--build-snapshot`
  at the ESM entry fails with `Cannot use import statement outside a module`.
- Snapshots forbid top-level `await`, open handles, and native addon
  initialization at snapshot time — all of which appear in real CLI entry points.

Adopting snapshots would require the packaged application to be pre-bundled and
transpiled to snapshot-compatible CommonJS, which is out of scope for a generic
packager. The compile cache (§4) delivers a portion of the same warm-start
benefit with none of these constraints, so it was chosen instead. Applications
that can produce a snapshot-compatible entry may still pass a custom command that
launches `node --snapshot-blob ...` themselves.

## Evaluated: application bundling (esbuild / tree-shaking)

Replacing the packaged `node_modules` tree with a single tree-shaken bundle was
prototyped against cdxgen and **deferred**. esbuild resolves the full module
graph, but the output does not run without extensive, app-specific tuning:

- Top-level `await` combined with circular dependencies produces invalid output
  (`Unexpected reserved word`) unless code splitting is enabled.
- CommonJS dependencies that `require()` builtins fail at runtime and need a
  `createRequire` banner.
- Data files loaded via `import.meta.url` / `__dirname`, dynamic `import()` of
  optional dependencies, and native `.node` / WASM addons must all be
  externalized and shipped alongside the bundle regardless.

Because caxa only receives a command array with `{{caxa}}` placeholders — not the
entry point, its externals, or its data directories — bundling cannot be a safe,
generic packager feature. It is inherently application knowledge and belongs in
the application's own build if pursued. The zstd payload already compresses the
raw JavaScript effectively, so the incremental compressed-size win did not
justify the per-release fragility. Left to the application.
