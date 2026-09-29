# Developing caxa

This guide is for people changing caxa itself: how the repository is laid out,
how to build and test it, the invariants the tests guard, and the platform
behaviour that shaped the 4.0 design. Most of the traps below were found the
hard way, usually by a test that passed on one platform and failed on another.

## Layout

| Path                     | What it is                                                                      |
| ------------------------ | ------------------------------------------------------------------------------- |
| `source/index.mts`       | The packager: CLI and API, compiled to `build/` by `tsc`                        |
| `stubs/`                 | The Rust runtime stub (`src/main.rs`, unit tests in `src/tests.rs`)             |
| `scripts/build-stubs.mjs`| Builds the stubs: all seven targets with cargo-zigbuild, or the host's with cargo |
| `test/e2e.test.mjs`      | End-to-end suite (`node:test`): builds real binaries and runs them              |
| `bench/`                 | Harness that builds and measures real `cdxgen` binaries (see its README)        |
| `docs/`                  | Performance notes, threat model, cross-platform builds, this guide              |

`stubs/Cargo.lock` is committed and every build uses `--locked`.

## Build and test

Prerequisites: Node.js 22.15 or newer, Rust 1.88 or newer with the `rustfmt`
and `clippy` components, and, for the cross-compiled stubs, zig 0.16 and
cargo-zigbuild 0.23 (the versions CI pins).

```bash
CAXA_STUBS=host npm ci     # installs, builds the host stub with cargo, compiles the packager
CAXA_STUBS=host npm test   # prettier, cargo fmt and clippy, stub unit tests, e2e suite
npm run format             # prettier and cargo fmt
npm run prepare            # cross-compiles all seven stubs (needs zig and cargo-zigbuild)
```

`npm test` rebuilds the stubs first (`pretest`), so without `CAXA_STUBS=host` it
cross-compiles all seven. CI runs the tests with `CAXA_STUBS=host` on Linux,
macOS and Windows, x64 and arm64, with Node.js 22.15, 24, 25 and 26, and a
separate job cross-compiles every stub, as the release job does.

Host notes:

- **cargo-zigbuild** uses the first `zig` it finds. A zig built for another OS,
  or a broken one, earlier on `PATH` makes it fail in confusing ways; set
  `CARGO_ZIGBUILD_ZIG_PATH` to a working zig.
- **Distribution cargo** is often older than 1.88. Put rustup's
  `~/.cargo/bin` first on `PATH`.
- **Windows** needs no MSVC: the stubs use the `*-pc-windows-gnullvm` targets.
  To run the stub unit tests on a Windows machine without a Rust toolchain,
  cross-build the test binary elsewhere (`cargo zigbuild --tests --target
  aarch64-pc-windows-gnullvm`) and run the `.exe` from `target/<target>/debug/deps`.
- **Clippy for another target** (Windows code behind `cfg(windows)` is not
  compiled on Unix) needs a C compiler for that target: point
  `CC_<target>` and `AR_<target>` at the zig wrappers that cargo-zigbuild
  creates in its cache directory, then `cargo clippy --target <target>`.
- **Compatibility tests** build the packager and stub of an older commit
  (`CAXA_MAIN_REF`, default `cacb50f`) into `test/.main-ref`, and skip when that
  commit is not in the clone, as in CI's shallow checkout. Run them locally with
  full history before changing the payload format.

## Invariants

Each of these is covered by tests; a change that breaks one breaks users in a
way that is hard to see.

1. **Payload bytes are a function of the input bytes and the settings.** Frame
   cuts depend only on the tar bytes and `CAXA_ZSTD_FRAME`, never on stream
   chunking or worker scheduling; parts depend only on the frame bytes and
   `CAXA_ZSTD_PART`; symlinks keep their real mtime; staged runtime files get
   fixed mtimes. The cache identifier is a hash of the payload, so any
   nondeterminism means a new extraction directory on every build. The e2e
   suite builds with 1, 2 and all workers and compares the bytes.
2. **A frame cut never separates a pax (`x`) or GNU long-name (`L`, `K`) record
   from its entry.** A frame that starts with an orphaned name record produces a
   binary that does not start. Global pax (`g`) headers are rejected for v2.
3. **Old readers still read new payloads.** New footer fields are ignored by
   older stubs, which then extract everything; aligned frames are padded with a
   pax `comment` record that tar readers ignore; parts are concatenated zstd
   frames, which decode as one stream. The e2e suite checks both directions
   against the `CAXA_MAIN_REF` packager and stub, and extracts aligned frames
   with the system `tar`.
4. **Everything is validated before anything touches the disk.** The trailer,
   index, footer, parts and placeholders are checked against hard caps (frame
   count and size, footer size, part count), and every frame must decode to
   exactly its declared size, so a corrupt or hostile binary fails with an error
   before extraction starts.
5. **Nothing is executed before it is complete.** A cold start extracts under a
   lock and runs nothing until the whole directory is in place. Files installed
   into a live directory (lazy members, and aligned frames) are written to a
   temp file and renamed into place only after they are verified, so a
   concurrent run sees either the placeholder or the whole real file.

## Platform behaviour that shaped the design

- **macOS kills a signed binary whose pages were written through a writable
  mapping,** at exec, even when its bytes are identical to the signed original,
  and each kill can raise a crash report. The in-place decode therefore rewrites
  such files with `write()` into a fresh file on macOS. Be careful when a test
  executes signed third-party binaries in a loop.
- **Apple's `strip` refuses read-only files,** and npm installs some binaries
  0444. caxa makes its copy writable for the duration.
- **Stripping invalidates a Mach-O signature, and arm64 macOS refuses to run
  a binary with an invalid one.** caxa re-signs the stripped Node ad hoc with
  the original's identifier, entitlements and hardened-runtime flag, and
  verifies the result with `codesign --verify --strict`.
- **ETXTBSY on Linux:** a writable descriptor left open across the rename lets
  a concurrent `execve` of the new file fail with ETXTBSY. The writer's lock
  lives on a read-only descriptor. Only Linux arm64 CI reproduced this; x86_64
  never did, even pinned to one core.
- **The umask cannot be read safely from a threaded process** (`umask(2)` sets
  it while reading it, and threads race). On Linux the stub reads it from
  `/proc/self/status`.
- **`/proc/self/exe`** is how the Linux stub finds itself, which also means code
  that uses it behaves differently under `cargo test`, where it is the test
  binary.
- **A detached helper must close inherited descriptors.** A Node parent that
  passes an extra pipe (`stdio[3]`) waits for EOF on it, and a prefetcher that
  kept it open held the parent until the prefetch finished.
- **An orphaned, stopped process group gets `SIGHUP`.** A test that stops the
  prefetcher with `SIGSTOP` must keep the app alive until it resumes it.
- **Windows** has no exec bits, so lazy selection on a Windows build host goes
  by file headers alone. A running exe can be renamed but not deleted or
  replaced, which is why lazy members are eager there. A just-run exe stays
  locked for about 200 ms (`EPERM`), and `fs.rmSync`'s `maxRetries` does not
  retry that for a file, so the e2e suite removes such files with its own retry
  loop (`cleanup()`).
- **32-bit targets** reject `window_log_max(31)`; the stub uses 30 there.
- **Node's zstd `nbWorkers`** is compiled in but runs on one core, and makes the
  output larger; the packager parallelizes with `worker_threads` instead.

## Testing traps

- **zstd raw blocks carry no checksum.** Incompressible data is stored raw, so
  flipping one of its bytes does not make the decode fail. Corrupt the frame
  magic or header to test a decode failure.
- **Shell-script fixtures need an explicit `exit 0`** when caxa appends bytes to
  them, or `sh` goes on to parse the appended bytes.
- **Two first runs, not one.** Anything that installs files (placeholders, the
  prefetcher, aligned frames) needs a test with concurrent first runs, and one
  that kills the writer mid-way.
- **Check the negative control.** A new test should fail on the code before the
  fix; run it once against the old build to be sure it tests what it claims.
- **Formatting** is part of `npm test`: prettier covers `source/`, `test/`,
  `bench/` and the Markdown docs, and `cargo fmt --check` and clippy with
  `-D warnings` cover the stub.

## Measuring

The [bench harness](../bench/README.md) builds real `cdxgen` binaries and
records size, extracted bytes, startup times and smoke results; its README
lists the measurement pitfalls. Report bytes, file counts and memory as the
primary results, and timings only from alternating runs.
