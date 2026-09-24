# caxa bench: regression and benchmark harness

This harness builds the real cdxgen standalone binaries with the caxa under test. It proves their features still work and records size, payload and startup numbers, so every caxa change can be compared against a baseline.

```bash
# caxa working tree vs. cdxgen HEAD, all 14 targets
node bench/run.mjs --cdxgen ../cdxgen

# baseline from a published caxa, then compare the working tree against it
node bench/run.mjs --cdxgen ../cdxgen --caxa-package @cdxgen/caxa@4.0.0 --out bench/results/base
node bench/run.mjs --cdxgen ../cdxgen --baseline bench/results/base/results.json

# a subset, re-measuring existing binaries without rebuilding
node bench/run.mjs --cdxgen ../cdxgen --targets cdxgen,cbom --out bench/results/x --skip-build
```

The harness exits non-zero when any of these happens:

- a build fails
- a smoke case fails
- compared with `--baseline`, a previously passing case fails or a case's output fingerprint changes

Results go to `<out>/results.json` and `<out>/summary.md`. Per-target build logs are in `<out>/logs/`.

## What it does

1. **Build.** It packs the caxa working tree (host stub only) and builds each target with cdxgen's own `.github/scripts/build-standalone.sh`. The build runs from a clean `git archive` of `--ref` (default `HEAD`), so the user's checkout is never touched. Using the production script means the harness gets:
   - every dependency profile, optional-package promotion, plugin pruning and preflight assertion
   - the script's own `--version`, `--help`, atom smoke test and size-limit checks

   A `pnpm` shim on `PATH` times the `pnpm dlx caxa` call, reported as `caxa s`, separately from the pnpm install.

2. **Measure**, per binary:
   - binary size
   - payload file count and bytes, from one extraction
   - cold start: `--version` with an empty `CAXA_TEMP_DIR`, which includes extraction
   - warm start: `--version` with the cache populated

   Each startup figure is taken over `--runs` runs (default 10). The page cache is not dropped between runs.

3. **Smoke.** It runs the cases in [cases.mjs](cases.mjs) (see below).

## Smoke cases

Each case checks what its target's profile is supposed to bundle:

| Target                | Cases                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cdxgen (full)         | cdxrs probe, trivy on a synthetic Alpine rootfs, atom `-t c`, `-t js --export-proto` (cdx-proto), payload contents (cdx-proto, cdx-hbom, jsonata, atom, osquery and trivy plugins) |
| cdxgen-slim           | GGUF model, JS+MCP services, profile excludes optional packages (`--export-proto` must report missing cdx-proto)                                                                   |
| aibom                 | Hugging Face model                                                                                                                                                                 |
| cbom                  | atom `-t c`, JS crypto assets                                                                                                                                                      |
| saasbom               | atom JS usages slices, atom-parsetools PHP slices (needs host php)                                                                                                                 |
| obom                  | osquery runtime inventory, trustinspector (darwin)                                                                                                                                 |
| hbom                  | devices plus `--export-proto`, `--include-runtime` osquery, diagnostics                                                                                                            |
| hbom-slim             | devices, profile excludes cdx-proto and plugins                                                                                                                                    |
| cdx-audit             | direct BOM audit (exit 3, CHE-006), severity gate                                                                                                                                  |
| cdx-sign / cdx-verify | Ed25519 sign, then verify; wrong key and tampered component must fail                                                                                                              |
| cdx-validate          | JSON and protobuf input                                                                                                                                                            |
| cdx-convert           | protobuf to SPDX 3, JSON to CycloneDX 1.5                                                                                                                                          |
| tracebom              | library trace (Linux), sandbox write policy                                                                                                                                        |

How the cases stay honest:

- **Negative controls.** Cases that depend on a plugin first run with that plugin's `*_CMD=/usr/bin/false` and require empty output. This covers atom, trivy, osquery, trustinspector and cdxrs. A silent fallback can't pass.
- **Hermetic environment.** Cases run with:
  - `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and `GLOBAL_NODE_MODULES_PATH=/nonexistent`
  - no inherited `*_CMD`, `CDXGEN_*` or `ATOM_*` variables
  - a fresh `CDXGEN_CACHE_DIR`

  A globally installed plugin or `atom` therefore can't mask a payload missing from the binary.

- **Offline.** No case needs network access. Cases that would reach registries, such as `--bom-audit` on source projects or predictive audit, are deliberately left out.
- **Fingerprints.** Outputs are reduced to deterministic, path-independent facts before being compared with the baseline: component counts, a digest of sorted purls, service names, rule IDs. Live-host outputs (obom, hbom) only get structural assertions.

The protobuf input for `cdx-validate` and `cdx-convert` is written with the `--cdxgen` checkout's own `lib/inventory/protobom.js`, so that checkout needs `pnpm install`.

## Known gaps

- It runs on macOS and Linux only. The Windows build path (`build-standalone.ps1`) is not wired in.
- golem, rusi, kosi, dosai and sourcekitten have no functional case: each needs a toolchain or network. Only their presence in the full payload could be checked.
- Atom cases need the native atom build. On jar-flavour platforms (darwin-x64, windows-arm64) they need a JDK on the case `PATH`.
- Two cases fail against cdxgen `08525330` because of real bugs in cdxgen's `build-standalone.sh`, not in caxa:
  - **tracebom ships without safer-exec** ([cdxgen#4378](https://github.com/cdxgen/cdxgen/issues/4378)). The `trace-runtime` profile asserts that `@cdxgen/safer-exec` is present, then calls `remove_platform_plugins`, which runs `rm -rf .../@cdxgen/safer-exec*`. The traced command never runs, and tracebom exits 0 with an empty BOM.
  - **aibom behaves like plain cdxgen** ([cdxgen#4379](https://github.com/cdxgen/cdxgen/issues/4379)). The script creates `bin/aibom.js`, but `target_entry_point` packages `aibom` with `bin/cdxgen.js`. The binary never sees the `aibom` name, so it doesn't default to `-t ai`.
- cdxgen observations found while building this harness, not caxa issues:
  - `cdx-validate` reports `schemaValid:false` for a protobuf BOM whose JSON form is valid, because empty `dependsOn` arrays are dropped in the round-trip ([cdxgen#4377](https://github.com/cdxgen/cdxgen/issues/4377)). The case pins today's value.
  - On macOS, tracebom records no libraries, so only the sandbox write policy is checked there.
