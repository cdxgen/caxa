# Binary size & startup performance

This document describes caxa's size- and startup-oriented architecture and
records the design exploration behind it, including the ideas that were
evaluated and not adopted, with the numbers that decided them.

- **3.1** (sections 1–5) was measured on macOS (Apple Silicon, Node.js 24)
  packaging a production `cdxgen` staging tree (~47 MB input).
- **4.0** (sections 6–11) was measured with the [bench harness](../bench/README.md)
  on the full `cdxgen` binary, native plugins included, on macOS arm64 with
  Node.js 26.8.2, unless a section says otherwise.

MB is 10⁶ bytes and MiB is 2²⁰ bytes; the harness reports binary sizes in MiB.
Startup times are medians and depend on the machine and its load; bytes, file
counts and memory are the reproducible metrics.

In caxa 4.0 the Go stub was replaced by a Rust stub (`stubs/src/main.rs`). The
3.1 sections below describe the Go implementation they were measured with; the
same behaviour (mkdir deduplication, compile cache, wrapper bypass + `execve`)
is kept in the Rust stub.

## Summary of 4.0 changes

| Change                                                               | Layer        | Effect                                                                                             |
| -------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
| Rust stub                                                            | stub         | Stub 3.0 → 0.5 MB; first-run extraction user CPU −35% (slim tree)                                  |
| [Parallel payload (v2)](#6-parallel-payload-format-v2)               | build + stub | caxa build 187 → 50 s, cold start 1,384 → 818 ms, binary +0.9%                                     |
| [Lazy members](#7-lazy-members)                                      | build + stub | 276 MiB fewer bytes written on a cold start (kosi, osqueryd, dosai), binary +0.03%                 |
| [`--lazy-auto` and prefetch](#8-lazy-auto-and-background-prefetch)   | build + stub | Cold-start writes 320.9 → 187.5 MB (seven more plugins), binary +0.4%                              |
| [In-place decode](#9-in-place-decode)                                | build + stub | Prefetcher peak 161.8 → 3–4 MB; Linux cold start with Node bundled: anonymous memory 160 → 8–11 MB |
| [Parallel decode of large files](#10-parallel-decode-of-large-files) | build + stub | The Node runtime decodes on 3–4 threads, for +1.0% of its compressed size                          |
| [Stripped Node runtime](#11-stripped-node-runtime)                   | build        | 2.2–2.5 MB less compressed size and 18–24 MB less written on every cold start                      |

Together, a cold start of the full `cdxgen` binary writes 187 MB instead of
610 MB.

### Rust stub

Measured on macOS arm64, Node.js 26.8.2, slim `cdxgen` 13.2.1 staging tree
(46 MB, 2835 files), `hyperfine`:

| Metric                                   | Go stub (3.1)   | Rust stub (4.0) |
| ---------------------------------------- | --------------- | --------------- |
| Stub size (darwin-arm64)                 | 3,024,002 B     | 518,736 B       |
| Final binary                             | 32,747,104 B    | 30,243,703 B    |
| Cold start: extract + `--version` (n=15) | 474.7 ± 13.5 ms | 453.4 ± 9.0 ms  |
| — user CPU                               | 521 ms          | 338 ms          |
| — system CPU                             | 501 ms          | 500 ms          |
| Warm `--version` (n=30)                  | 199.6 ± 4.8 ms  | 203.5 ± 8.7 ms  |

Stub sizes for every target: darwin-x64 589 KB, linux-x64 695 KB, linux-arm64
591 KB, linux-arm 595 KB, win32-x64 675 KB, win32-arm64 498 KB (Go: 3.0–3.4 MB).
Later 4.0 features grew the darwin-arm64 stub to about 605 KB.

On this small tree, cold start is dominated by filesystem system time spent
creating files, not by decompression. The pure-Rust `ruzstd` decoder was
evaluated and rejected: it caps the window at 100 MB, below the 128 MB
(`--long=27`) window caxa compresses with.

## Where the bytes actually are

Profiling a slim `cdxgen` native binary (30.7 MB, zstd level 19) shows the payload is
dominated by the bundled Node.js runtime and its shared libraries — not the
application's `node_modules`:

| Component                        | Compressed | Share |
| -------------------------------- | ---------- | ----- |
| Node runtime shared libraries    | 23.8 MB    | ~77%  |
| — `libicudata` (full ICU data)   | 8.8 MB     | ~29%  |
| — `libnode` (V8 + core)          | 9.9 MB     | ~32%  |
| — `libcrypto` and other libs     | ~5 MB      | ~16%  |
| Application `node_modules`+ code | ~4 MB      | ~13%  |
| Go stub (4.0 Rust stub: ~0.5 MB) | ~3 MB      | ~10%  |

Two consequences:

- Trimming `node_modules` yields diminishing returns (zstd already compresses
  redundant text well); expanding the default excludes shaved only ~54 KB off
  this payload. It is still worthwhile because fewer files means fewer extraction
  syscalls, but it is not where the size is.
- The largest single lever is **ICU**. Full ICU data is ~29% of the binary and
  is only needed for locale-aware `Intl` across many languages. Building or
  installing Node with `--with-intl=small-icu` (or `system-icu`) removes it, but
  that is a property of the Node build the packager is fed — it cannot be changed
  by caxa, which only copies whatever shared libraries the host `node` links
  against. Applications that do not need non-English locale data should package a
  small-ICU Node build.

The full `cdxgen` binary, which bundles native plugins, looks different. With
cdxgen 13.3.0 and its plugins on darwin-arm64 (136.0 MiB compressed payload,
584.8 MiB extracted, 3,572 files):

| Asset                             | Compressed | Share | Extracted |
| --------------------------------- | ---------: | ----: | --------: |
| kosi                              |   36.7 MiB |   27% | 126.0 MiB |
| Node runtime shared libraries     |   26.2 MiB |   19% | 105.7 MiB |
| atom (native)                     |   21.8 MiB |   16% |  89.5 MiB |
| osquery                           |   17.5 MiB |   13% | 105.3 MiB |
| dosai                             |   14.4 MiB |   11% |  54.3 MiB |
| trivy                             |    7.8 MiB |    6% |  27.4 MiB |
| everything else (JS, data, tools) |   11.6 MiB |    9% |  76.6 MiB |

About 95% of this payload is native code, most of which a given run never
starts, and JavaScript and data are about 5%. That is why 4.0 concentrates on
extracting less (lazy members), extracting in parallel and decoding large files
without large buffers, rather than on the JavaScript tree. It also showed that
the biggest size wins were in the input tree rather than in caxa: a Java
fallback of atom that native targets never use was 30% of the compressed
binary, and removing it from cdxgen's build cut the binary by 31%. A universal
(x86_64 + arm64) osquery build carried a 10.1 MB compressed slice that arm64
never runs. Measure the payload before tuning the packager.

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

`--upx` now compresses only the runtime stub (~3 MB for the Go stub, about
0.5 MB for the 4.0 Rust stub). The Node.js runtime is stored uncompressed inside
the tar and compressed once by the outer zstd layer, so it can be memory-mapped
directly at launch.

## 3. Extraction: deduplicated directory creation

The runtime stub extracts the payload with a worker pool. Previously every file,
symlink, and large-file entry issued its own `os.MkdirAll` for the parent
directory. Because `node_modules` trees have thousands of files sharing a handful
of parent directories, the stub now records created directories in a shared set
(a `sync.Map` in the Go stub, a mutex-guarded `HashSet` in the Rust stub) and
skips the redundant syscalls. Directory creation remains idempotent, so the rare
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

## 5. Launch: wrapper bypass and `execve` (Unix)

Two costs sat between the stub and the running Node process:

1. On macOS/Linux the portable Node bundle includes a small `sh` wrapper that
   only exists to export `DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH` before running
   the real binary. Launching it meant forking a shell on every start.
2. The stub launched Node as a child with `exec.Command(...).Run()` and waited,
   leaving the stub (~3 MB RSS) in the process tree for the whole run and
   relaying signals through Go's runtime.

On Unix the stub now detects the wrapper layout (`<name>-real` binary +
`<name>-libs` directory beside the referenced `<name>`), sets the library search
path itself, and calls `syscall.Exec` (`execve`) to **replace itself** with the
real Node binary. The result is a single process — no shell, no lingering stub:

```
before:  stub -> sh wrapper -> node-real
after:   node-real            (stub image replaced in place)
```

Benefits, all verified end-to-end:

- Process tree shows only `node-real`; the stub and shell are gone.
- Exit status is Node's own (a script exiting 42 yields 42).
- Signals reach Node directly (`SIGTERM` handled by the app, no Go relay).
- ~15 ms shaved off warm start (approx. 499 ms -> 483 ms for cdxgen `--version`)
  plus the removed shell fork and stub RSS.

The wrapper is still generated for the `.app` and `.sh` output modes, which do
not use the native stub. Windows keeps the child-process launch (`execve` semantics
do not apply) and finds its DLLs beside `node.exe`.

## 6. Parallel payload (format v2)

A v1 payload is one zstd stream: the build compresses it on one core and the
stub decodes it on one core. The full `cdxgen` payload, about 760 MiB before
compression at the time, took four minutes to build and more than a second to
extract.

Node's bundled zstd does accept `ZSTD_c_nbWorkers`, but it does not help. On a
177.6 MB corpus of real `.js`/`.json` files at the packager's settings, 14
workers ran on one core and took 25.3–28.2 s against 14.2–15.9 s
single-threaded, and the output grew by 18%. v2 therefore cuts the tar stream
into frames and compresses each one as an independent zstd frame on
`worker_threads`, with a single-threaded context per frame:

- A frame ends at the first tar entry boundary after `CAXA_ZSTD_FRAME` bytes
  (8 MiB by default). Cuts depend on the tar bytes and that setting alone, never
  on stream chunking or worker scheduling, so payloads are byte-identical across
  repeat builds and worker counts, which the content-addressed cache identifier
  depends on.
- A cut never separates a pax or GNU long-name record from the entry it
  describes: a frame that starts with an orphaned name record produces a binary
  that does not start.
- The stub validates the whole index first, then decodes frames on
  `min(cores, 1 GiB / largest frame)` threads (256 MiB on 32-bit), each into a
  buffer of exactly its declared size, and extracts every frame's entries with a
  shared directory cache.

| `cdxgen`                 | macOS arm64: v1 → v2     | Linux arm64 (Docker): v1 → v2 |
| ------------------------ | ------------------------ | ----------------------------- |
| caxa build               | 187 s → 50 s             | 102 s → 47 s                  |
| Binary                   | 227.46 → 229.40 MB       | 246.89 → 247.95 MB            |
| Cold start (median ± sd) | 1,384 ± 14 → 818 ± 33 ms | 1,483 ± 56 → 982 ± 93 ms      |
| Warm start               | 202 → 200 ms             | 195 → 195 ms                  |

Independent frames lose the matches that would have crossed a frame boundary,
which costs 0.4–0.9% here. On a synthetic worst case, 177 MB of concatenated
JavaScript whose compression comes mostly from long-range matches, 8 MiB frames
came to 21.4 MB against 5.8 MB for one stream. The real payload is mostly large
native files, each of which fits in a frame of its own, so the cost stays small;
only a measurement on the real payload can tell the two apart.

## 7. Lazy members

In the full `cdxgen` binary, three plugins (kosi, osqueryd and dosai) are half
of the compressed payload and 278 MiB of every cold start's writes, and none of
them runs in cdxgen's default flows. A lazy member is packed in its own frame at
the end of the payload; a cold start writes a small placeholder in its place,
and the member's first run decodes, verifies and installs the real file, then
execs it (see the README for the protocol).

| `cdxgen`, kosi, osqueryd and dosai lazy | Before        | After                 |
| --------------------------------------- | ------------- | --------------------- |
| Binary                                  | 143,144,180 B | +37,988 B (+0.027%)   |
| Extracted on a cold start (`du -sk`)    | 610,368 KB    | 327,692 KB (−276 MiB) |
| Cold start (15 alternating runs)        | 888.2 ms      | 681.1 ms (−23%)       |

The binary grows by the placeholder code in the stub and by each member losing
the zstd context of its neighbours. Handing out eager frames largest first, so
that the longest frame starts first, measured within noise (about 44 ms slower
without lazy members, level with them); it is kept because it bounds the
critical path when one frame dominates.

The rule that comes with lazy members is that a member must only be executed:
anything that reads it before its first run gets the placeholder. Tracing every
smoke case of cdxgen found 34,524 file events and no read of a member path, only
execs and `stat` calls.

## 8. `--lazy-auto` and background prefetch

Maintaining lazy globs per target does not scale, so `--lazy-auto` selects every
native executable (ELF, Mach-O, PE) of at least 1 MiB, except the files the
command names. `#!` scripts are never auto-selected, because interpreters read
them and npm gives every package `bin` script an exec bit. On `cdxgen` it added
atom (89.4 MiB), trivy (20.3), golem (7.6), cdxrs (5.5), trustinspector (4.6),
rusi (2.6) and cdxui (1.3) to the three globs of section 7:

| `cdxgen`                  | Globs only    | Globs + `--lazy-auto`  |
| ------------------------- | ------------- | ---------------------- |
| Binary                    | 143,181,431 B | 143,765,341 B (+0.41%) |
| Written on a cold start   | 320,927,416 B | 187,456,234 B (−41.6%) |
| Cold `--version` peak RSS | 357,328 KB    | 224,032 KB             |

Without prefetch, every member stays a placeholder until its first run, which
then pays for the decode. After a cold start the stub therefore spawns one
detached copy of itself at `nice 10` that materializes the remaining
placeholders in the background and leaves a marker, so warm starts skip the
scan. Short commands return immediately.

The prefetcher runs alongside the app, so its memory adds to the app's. Its
first version peaked at 301 MB, because the allocator kept each member's
buffers; reusing one pair of buffers brought it to 162 MB, the size of the
largest member (kosi: 34.1 MiB compressed plus 118.3 MiB decoded). The in-place
decode of the next section took it to a few megabytes.

## 9. In-place decode

A frame is a single-segment zstd frame, so a streaming decoder still needs the
whole decoded size as its window: decoding kosi needs 118 MiB of memory however
it is buffered. 4.0 removes that buffer by decoding straight into the file:

- **Layout.** A lazy member's frame, and the frame of every hot file of at least
  8 MiB, starts with a pax header whose `comment` record is padded so that the
  file's data begins at a 64 KiB-aligned offset of the decoded frame, and the
  frame ends right after the data. tar readers ignore `comment`, so older stubs,
  the Windows stub, bsdtar and GNU tar extract these frames unchanged.
- **Stub (Unix).** It preallocates the temp file, so that a full disk fails
  there and not as a `SIGBUS` later, maps it at the data offset, and streams
  zstd into the mapping with a stable output buffer, the mapping itself being
  the window. The file is renamed into place only after its sha256 (lazy
  members), decoded size and tar entry check out.

| Measurement                                                 | Before     | After           |
| ----------------------------------------------------------- | ---------- | --------------- |
| Prefetcher, full `cdxgen` (darwin-arm64, peak footprint)    | 161.8 MB   | 3.0–4.3 MB      |
| 120 MB incompressible member (Linux x86_64, peak `RssAnon`) | 234,692 kB | 1,264 kB        |
| Cold start with Node bundled (Linux x86_64, peak `RssAnon`) | 155,844 kB | 8,116–10,300 kB |

What remains of the peak RSS is the page cache of the mapped files, which the
kernel can reclaim. The aligned layout costs almost nothing: with it, `cdxgen`
is 137.14 MiB, against 137.11 MiB without it.

On macOS, a signed binary whose pages were written through a writable mapping
is killed at exec, even when its bytes are identical: osqueryd got `SIGKILL`.
On macOS the verified bytes are therefore written once more, with `write()`,
into a fresh file, so each large file passes through the page cache twice.

## 10. Parallel decode of large files

Frames are decoded in parallel, but a large file is one frame, and a cold start
waits for its longest frame: the bundled Node runtime, which every cold start of
every target extracts, and on first use a lazy member such as a 90 MB plugin.
Aligned frames longer than 32 MiB are therefore compressed in parts, one zstd
frame per 32 MiB slice, stored one after another in the frame's index entry and
listed in the footer. The stub decodes the parts on parallel threads, each
straight into its own range of the file. What it costs is compression across
the part boundaries (stripped darwin-arm64 Node 24, level 19, `--long=27`):

| Node binary, 96.9 MB | Compressed | Cost  |
| -------------------- | ---------- | ----- |
| one frame            | 25.86 MB   |       |
| 4 parts              | 26.11 MB   | +1.0% |
| 8 parts              | 26.57 MB   | +2.7% |

32 MiB parts put the Node runtime at 3 or 4 parts. Concatenated zstd frames are
a single valid zstd stream, so stubs from before parts, tar tooling and v1
decoders read the same entry as before. Each hot part streams through a 1 MiB
buffer, so a cold start's anonymous memory stays at a few megabytes (4.9 MB
with 4 parts on Linux, against 1.6 MB for one frame). The prefetcher decodes on
one thread, so as not to compete with the app.

## 11. Stripped Node runtime

caxa bundles a copy of the Node executable that runs the build, and official
Node releases ship with their full symbol table. It is never read at run time:
native addons link against the dynamic symbol table (Linux) or the export trie
and global symbols (macOS), which stripping keeps. Yet every cold start writes
it to disk, and it costs compressed size in every binary. Measured on official
Node 24 builds (zstd level 19, `--long=27`):

| Node 24 binary         | Raw              | Compressed     |
| ---------------------- | ---------------- | -------------- |
| linux-x64 (24.13.0)    | 121.2 → 103.4 MB | 31.4 → 28.9 MB |
| darwin-arm64 (24.18.0) | 121.0 → 96.9 MB  | 28.1 → 25.9 MB |

The stripped Linux binary loads N-API addons (checked with `sqlite3`), and the
macOS one keeps all 33,270 exported symbols. On macOS the copy is re-signed ad
hoc with the original's identifier, entitlements and hardened-runtime flag,
since arm64 macOS does not run a binary whose signature stripping invalidated.
Homebrew's Node, split into dylibs, gains as well: `libnode` goes from 56.4 to
41.9 MB. `--no-strip-node` keeps the symbols (see the README).

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

## Evaluated: archive format (tar overhead)

The payload is a `tar` stream piped through zstd. `tar` adds a 512-byte header
plus block padding per entry, which sounds expensive for the thousands of small
files in a `node_modules` tree. Measured on the cdxgen payload (3,777 files):

| Layout                              | Size    |
| ----------------------------------- | ------- |
| Raw file contents                   | 36.3 MB |
| `tar` of those files (uncompressed) | 39.5 MB |
| `tar` + zstd-19 (current)           | 4.14 MB |
| Raw contents + zstd-19 (no tar)     | 4.04 MB |

So the ~3.2 MB (8.8%) of uncompressed tar overhead collapses to ~94 KB (2.3% of
the payload) after zstd, because headers and padding are highly compressible. A
custom container format (concatenation + manifest, zip, etc.) could reclaim at
most that ~94 KB while making the stub reader significantly more complex and
giving up tar's portable handling of symlinks, permissions, and directories. The
real cost of many files is extraction syscalls, addressed by the worker pool and
`mkdir` deduplication (§3), and further reduced by cutting file count via
excludes. Conclusion: **keep `tar` + zstd**. 4.0 kept this conclusion: frames,
alignment and parts are all built from standard tar records and zstd frames.

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
justify the per-release fragility. Left to the application. The full `cdxgen`
payload confirms it: JavaScript and data are about 5% of it.

## Evaluated for 4.0 and not adopted

These were measured on the full `cdxgen` binary (darwin-arm64 unless noted) and
left out, either because the gain did not justify the complexity or because the
decision belongs to the application or plugin packager rather than to caxa.

- **Branch/call filters before zstd.** A BCJ filter rewrites relative branch
  targets in machine code to absolute ones, which compress better. xz's ARM64
  filter in front of zstd `-19 --long=27` saved 6.35 MB across the native
  plugins and the Node runtime (kosi −2.0, osqueryd −1.6, atom −1.55,
  libnode −0.8, trivy −0.4 MB) but made dosai 0.27 MB larger; a simplified x86
  filter saved 0.9 MB on Node for linux-x64. It needs a filter decoder in the
  stub, per-file and per-architecture selection, and a payload format change.
- **Unpacking UPX-packed plugins.** Some plugin packages ship their Linux
  executables UPX-packed (osquery, trivy and kosi for linux-amd64), and zstd
  gains nothing on them. Unpacked, even with a branch filter, they make the
  binary 6.2 MB larger, although they use far less memory at run time (peak RSS
  for `--version`, packed against unpacked: kosi 90 against 14 MB, osquery 109
  against 46 MB, trivy 148 against 100 MB). That trade belongs to the plugin
  packager.
- **A content-addressed store shared by all caxa binaries.** The 15 binaries of
  the bench harness keep 3,154 MiB in their caches, and of the 2,682 MiB in
  files of at least 1 MiB only 703 MiB are unique: most variants share every
  large file with `cdxgen`, and two `cdxgen` builds four days apart share 69%
  of their large files. Storing files once by hash and linking them into each app
  directory would save most of that disk space, but it couples the caches of
  unrelated binaries: shared objects need garbage collection and trust between
  binaries that happen to share a cache root, which per-identifier directories
  avoid.
- **Lazy members on Windows.** A running exe can be renamed on Windows but not
  deleted, so a placeholder could step aside, install the real member at its
  path and run it as a child in a job object, passing its exit code on. That is
  a second launch model to maintain; lazy frames are extracted eagerly on
  Windows instead.
- **Stripping bundled plugins.** `strip -x` on osqueryd saves about 1.3 MB
  compressed per architecture slice but invalidates the vendor's signature.
  caxa strips only the Node runtime it bundles, and leaves plugins as their
  vendors ship them.
- **Deduplicating identical files within one payload.** The full `cdxgen`
  payload has ten duplicate files, all small, so there is nothing to gain.
