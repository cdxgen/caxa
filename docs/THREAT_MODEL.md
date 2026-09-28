# Threat Model

This document describes the threat model for caxa — a Node.js application packager that creates self-extracting executables using a TypeScript builder and a native Rust bootstrap stub. It identifies threat actors, trust boundaries, attack surfaces, and mitigations across caxa's main components: CLI, library API, archive creation pipeline, portable Node bundling, runtime extraction stub, and release artifacts.

## System Overview

caxa packages a Node.js application into a self-extracting executable by:

1. Collecting files from an input directory
2. Applying default and user-provided exclude rules
3. Bundling a portable Node runtime when requested
4. Creating a compressed tar payload (`gzip` or `zstd`)
5. Appending the payload plus footer metadata to a native Rust stub
6. Extracting the payload to a local cache directory and launching the packaged command

caxa operates in four primary modes:

1. **CLI** (`build/index.mjs`) — Command-line packaging of a project
2. **Library** (`source/index.mts`) — Programmatic use from JavaScript/TypeScript
3. **Native Runtime Stub** (`stubs/src/main.rs`) — Self-extracting executable bootstrapper
4. **Shell Stub** (`.sh` mode) — POSIX shell-based self-extracting script

## Trust Boundaries

```text
┌──────────────────────────────────────────────────────────────────────┐
│                         User Environment                             │
│  ┌───────────┐   ┌──────────────┐   ┌────────────────────────────┐   │
│  │ CLI / API │   │ Build Inputs │   │ Packaged Binary Execution  │   │
│  └─────┬─────┘   └──────┬───────┘   └──────────────┬─────────────┘   │
│        │                │                          │                 │
│  ══════╪════════════════╪══════════════════════════╪══════           │
│  Trust boundary 1: caxa code ←→ input project tree / metadata        │
│        │                                          │                  │
│  ┌─────▼──────────────────────────────┐  ┌────────▼───────────────┐  │
│  │ TypeScript builder + archive flow  │  │ Native / shell stub    │  │
│  └─────┬──────────────────────────────┘  └────────┬───────────────┘  │
│        │                                          │                  │
│  ══════╪══════════════════════════════════════════╪══════            │
│  Trust boundary 2: packaged payload ←→ host filesystem/cache         │
│        │                                          │                  │
│  ┌─────▼──────────────────────────────────────────▼──────────────┐   │
│  │          Extracted application tree and bundled runtime       │   │
│  └───────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘

Trust boundary 3: caxa release process ←→ published npm package / artifacts
Trust boundary 4: caxa process ←→ external tools (`cargo`, `zig`, `upx`) and platform loaders
```

## Threat Actors

| Actor                             | Capability                                                                     | Motivation                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Malicious project author**      | Controls the input directory being packaged                                    | Ship a binary that leaks secrets, breaks extraction safety, or poisons caches |
| **Environment manipulator**       | Controls env vars or temp/cache locations during build or runtime              | Influence tool behavior, redirect cache use, or alter runtime lookup          |
| **Compromised dependency/tool**   | Compromises `archiver`, Node.js, Rust crates, UPX, or platform loader behavior | Execute unintended code during packaging or extraction                        |
| **Compromised release pipeline**  | Modifies published npm artifacts or prebuilt stubs                             | Distribute tampered packages or binaries                                      |
| **Local attacker on shared host** | Can inspect or race temp/cache directories                                     | Read extracted content or interfere with cache reuse                          |

## Threats and Mitigations by Component

### 1. CLI and Library (`build/index.mjs`, programmatic API)

#### T1.1 — Command injection during build

**Threat:** User-controlled paths or options escape command boundaries when caxa invokes external tools such as `upx` or `cargo`.

**Mitigations:**

- caxa uses array-based `spawn` invocation instead of shell-evaluated command strings
- UPX arguments are split explicitly before execution
- Rust stub builds (`cargo build --locked`) are controlled by a Node-managed script rather than shell glue

**Residual risk:** Low.

#### T1.2 — Dangerous file inclusion from the input tree

**Threat:** caxa unintentionally includes secrets, metadata, or bulky non-runtime files from the project tree, increasing size or exposing sensitive material.

**Mitigations:**

- `defaultExcludes` remove common VCS, CI, docs, tests, sourcemaps, declarations, and package metadata
- users can provide stricter excludes for their own project layout

**Residual risk:** Medium — application-specific secrets can still be included if users do not exclude them.

#### T1.3 — Build self-contamination

**Threat:** Generated sidecar artifacts from one build become input to a subsequent build and change payload contents unexpectedly.

**Mitigations:**

- `binary-metadata.json` is excluded by default
- temp payloads are created outside the packaged tree and removed after use

**Residual risk:** Low.

### 2. Archive Creation and Portable Node Bundling

#### T2.1 — Portable runtime library confusion

**Threat:** The packaged binary resolves shared libraries from unintended host locations instead of the bundled runtime.

**Mitigations:**

- caxa discovers non-system runtime dependencies explicitly for macOS and Linux
- wrapper scripts set `DYLD_LIBRARY_PATH` or `LD_LIBRARY_PATH` to the packaged runtime directory
- Windows packaging copies neighboring runtime `.dll` files next to the bundled executable

**Residual risk:** Medium — platform loader behavior varies across distributions and vendor builds.

#### T2.2 — Non-deterministic cache identity

**Threat:** Identical application payloads produce different cache identifiers, causing unnecessary re-extraction and making cache integrity harder to reason about.

**Mitigations:**

- content-addressed identifiers can be derived from the payload hash
- portable runtime staging normalizes file mtimes to stabilize payload fingerprints
- stripping the bundled runtime (`strip`, and an ad-hoc `codesign` on macOS) is deterministic, and split frames are cut from the frame bytes and the part size alone
- users can still override with `--identifier` when isolation is preferred over reuse

**Residual risk:** Low to Medium.

#### T2.3 — Bundled runtime no longer matches its upstream release

**Threat:** The stripped Node executable no longer matches the checksum of the Node release it was copied from, and on macOS no longer carries the Node.js Foundation's Developer ID signature. A consumer who verifies the bundled runtime against upstream, or trusts it because of that signature, can be misled or can reject a legitimate binary.

**Mitigations:**

- only symbols are removed: `strip --strip-all` keeps the dynamic symbol table on Linux, and `strip -x` keeps every global symbol on macOS
- on macOS the copy is signed ad hoc with the original's identifier, entitlements and hardened-runtime flag, then checked with `codesign --verify --strict`; any failure bundles the unstripped original with a warning
- `binary-metadata.json` marks a stripped runtime with `cdx:caxa:stripped` on the Node component
- `--no-strip-node` bundles the runtime byte for byte for those who verify it against upstream

**Residual risk:** Low.

### 3. Native Runtime Stub (`stubs/src/main.rs`)

#### T3.1 — Path traversal during extraction

**Threat:** A crafted tar entry escapes the intended extraction root and overwrites host files.

**Mitigations:**

- extraction targets are validated against the cleaned destination prefix
- unsafe paths cause extraction failure
- tests cover zip-slip style traversal attempts

**Residual risk:** Low.

#### T3.2 — Malformed footer or trailer parsing

**Threat:** A modified binary causes the stub to misinterpret payload boundaries or execute with attacker-controlled metadata.

**Mitigations:**

- trailer offsets and footer size relationships are validated
- invalid footer JSON or overlapping payload/footer regions abort execution
- a split frame's `parts` must be non-empty and sum exactly to its index entry, with a bounded count; each part decodes into its own disjoint range, bounded by its declared size, and a lazy member's sha256 is computed over the very part buffers that were decoded
- legacy fallback parsing still validates separators and JSON structure

**Residual risk:** Low.

#### T3.3 — Cache corruption or unsafe reuse

**Threat:** Concurrent processes race extraction or reuse a partially extracted cache directory.

**Mitigations:**

- extraction uses lock directories before a cache is considered usable
- failed extraction removes partial directories and locks
- content-addressed identifiers permit reuse only when payload contents match

**Residual risk:** Medium — a local attacker with write access to the cache directory can still interfere unless the host is isolated.

### 4. Shell Stub Mode

#### T4.1 — Shell execution environment influence

**Threat:** Host shell behavior, inherited environment variables, or temp directory behavior alters extraction or launch flow.

**Mitigations:**

- shell mode is explicitly limited and documented
- shell stubs remain gzip-only, reducing format complexity in this path
- users can override `CAXA_TEMP_DIR` deliberately for controlled environments

**Residual risk:** Medium — shell execution inherits more host behavior than the native Rust stub path.

### 5. CI/CD and Release Artifacts

#### T5.1 — Tampered stub binaries or published package

**Threat:** Prebuilt stubs or published npm artifacts are modified during release.

**Mitigations:**

- Rust stubs are built from committed source and a committed `Cargo.lock` in the repository
- tests rebuild stubs locally before verification
- caxa now has a minimal runtime dependency surface, reducing supply-chain exposure

**Residual risk:** Medium — provenance and artifact signing remain important release controls.

## Security Controls Summary

| Control Area            | Current Controls                                                                  |
| ----------------------- | --------------------------------------------------------------------------------- |
| Extraction safety       | Tar path validation, symlink-aware copy logic, lock directories                   |
| Build process safety    | Array-based subprocess invocation, minimized shell usage                          |
| Runtime portability     | Explicit runtime dependency discovery and packaged library wrappers               |
| Cache reuse integrity   | Payload-derived identifiers for identical builds                                  |
| Artifact hygiene        | Conservative default excludes for docs, tests, sourcemaps, declarations, metadata |
| Dependency minimization | Single runtime npm dependency (`archiver`)                                        |

## Residual Risks and Design Tradeoffs

- caxa intentionally extracts application files to disk; it is not a source-hiding product
- caxa packages existing applications and runtimes; it does not sandbox the packaged app itself
- portable runtime support depends on platform-specific loader behavior and upstream Node distribution layouts
- shell stub mode is inherently less controlled than the native Rust stub path
- default excludes are conservative but cannot know every application's runtime needs

## Operational Guidance

- Package untrusted projects only in isolated environments
- Use explicit `--identifier` values when shared cache reuse is not desired
- Review and tighten excludes for projects with secrets or large non-runtime assets
- Prefer native stub outputs over shell stub outputs where possible
- Validate packaged binaries in CI with startup and cache reuse smoke tests

## Related Documents

- [../SECURITY.md](../SECURITY.md) — Security reporting policy and supported versions
- [../README.md](../README.md) — Packaging model, compression choices, and runtime behavior
