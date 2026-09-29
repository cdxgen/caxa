#!/usr/bin/env node

// caxa regression and benchmark harness for the cdxgen standalone binaries.
//
// Builds the real cdxgen targets through cdxgen's own
// .github/scripts/build-standalone.sh (so every dependency profile, optional
// package promotion, pruning and preflight check is exactly what ships), using
// the caxa under test. Then, per binary, it records size, payload file count,
// build time, cold/warm startup, and runs the feature smoke cases from
// cases.mjs. With --baseline it compares against an earlier results.json and
// exits non-zero on any regression in behaviour.
//
// Usage:
//   node bench/run.mjs --cdxgen ../cdxgen [--ref HEAD] [--targets a,b]
//                      [--caxa-package <spec>] [--out dir] [--runs 10]
//                      [--baseline old/results.json] [--skip-build]

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { cases } from "./cases.mjs";

const ALL_TARGETS = [
  "aibom",
  "cdxgen",
  "cdxgen-slim",
  "cbom",
  "obom",
  "saasbom",
  "cdx-audit",
  "cdx-verify",
  "cdx-sign",
  "cdx-validate",
  "cdx-convert",
  "hbom",
  "hbom-slim",
  "tracebom",
];

const caxaRoot = path.resolve(import.meta.dirname, "..");

const { values: opts } = parseArgs({
  options: {
    cdxgen: { type: "string" },
    ref: { type: "string", default: "HEAD" },
    targets: { type: "string" },
    "caxa-package": { type: "string" },
    out: { type: "string" },
    runs: { type: "string", default: "10" },
    baseline: { type: "string" },
    "skip-build": { type: "boolean", default: false },
    "skip-smoke": { type: "boolean", default: false },
  },
});

if (!opts.cdxgen) {
  console.error("--cdxgen <path to a cdxgen git checkout> is required");
  process.exit(2);
}
if (process.platform === "win32") {
  // build-standalone.sh is bash; the Windows path (build-standalone.ps1) is not wired yet.
  console.error("The harness currently supports macOS and Linux only.");
  process.exit(2);
}

const cdxgenRepo = path.resolve(opts.cdxgen);
const targets = opts.targets
  ? opts.targets.split(",").filter(Boolean)
  : ALL_TARGETS;
for (const t of targets) {
  if (!ALL_TARGETS.includes(t)) {
    console.error(`Unknown target: ${t}`);
    process.exit(2);
  }
}
const runs = Number.parseInt(opts.runs, 10);
const outDir = path.resolve(
  opts.out ??
    path.join(
      caxaRoot,
      "bench",
      "results",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
);
const srcDir = path.join(outDir, "src");
const binDir = path.join(outDir, "bin");
const logDir = path.join(outDir, "logs");
const workDir = path.join(outDir, "work");
mkdirSync(logDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (res.error) throw res.error;
  return res;
}

function must(cmd, args, options = {}) {
  const res = run(cmd, args, options);
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (${res.status}):\n${res.stderr || res.stdout}`,
    );
  }
  return res;
}

function fileCountAndBytes(dir, skip = new Set()) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files++;
        bytes += statSync(p).size;
      } else files++;
    }
  };
  walk(dir);
  return { files, bytes };
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  const round = (n) => Math.round(n * 10) / 10;
  return {
    mean: round(mean),
    median: round(s[Math.floor(s.length / 2)]),
    stddev: round(sd),
    min: round(s[0]),
    max: round(s.at(-1)),
    n: s.length,
  };
}

function timeMs(fn) {
  const t0 = process.hrtime.bigint();
  const r = fn();
  return [Number(process.hrtime.bigint() - t0) / 1e6, r];
}

// ---------------------------------------------------------------------------
// 1. caxa package under test
// ---------------------------------------------------------------------------

function caxaVersion() {
  return JSON.parse(readFileSync(path.join(caxaRoot, "package.json"), "utf8"))
    .version;
}

function prepareCaxaPackage() {
  if (opts["caxa-package"])
    return { spec: opts["caxa-package"], label: opts["caxa-package"] };
  // Pack the working tree with only the host stub: the harness runs on the host.
  const env = { ...process.env, CAXA_STUBS: "host" };
  must("npm", ["pack", "--pack-destination", outDir], { cwd: caxaRoot, env });
  const tgz = path.join(outDir, `cdxgen-caxa-${caxaVersion()}.tgz`);
  const commit = run("git", ["rev-parse", "--short", "HEAD"], {
    cwd: caxaRoot,
  }).stdout.trim();
  const dirty =
    run("git", ["status", "--porcelain"], { cwd: caxaRoot }).stdout.trim() !==
    "";
  return {
    spec: tgz,
    label: `local ${caxaVersion()} @ ${commit}${dirty ? " (dirty)" : ""}`,
  };
}

// ---------------------------------------------------------------------------
// 2. Build every target through cdxgen's production build script
// ---------------------------------------------------------------------------

// A pnpm shim first on PATH times the `pnpm --package=<caxa> dlx caxa ...` call,
// separating caxa's packaging time from pnpm install time without modifying the
// cdxgen build script.
function installPnpmShim() {
  const shimDir = path.join(outDir, "shim");
  mkdirSync(shimDir, { recursive: true });
  const realPnpm = must("sh", ["-c", "command -v pnpm"]).stdout.trim();
  const shim = path.join(shimDir, "pnpm");
  writeFileSync(
    shim,
    `#!/bin/sh
case " $* " in
  *" dlx caxa "*)
    start=$(node -e 'process.stdout.write(String(Date.now()))')
    "${realPnpm}" "$@"; rc=$?
    end=$(node -e 'process.stdout.write(String(Date.now()))')
    echo "$((end - start))" >> "$CAXA_BENCH_TIMING"
    exit $rc ;;
esac
exec "${realPnpm}" "$@"
`,
  );
  chmodSync(shim, 0o755);
  return shimDir;
}

function buildTargets(caxaSpec) {
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  // A clean tree: the script's post-build SBOM scans its working directory, and
  // outputs must not land in the user's checkout.
  const archive = must("git", ["archive", "--format=tar", opts.ref], {
    cwd: cdxgenRepo,
    encoding: "buffer",
  }).stdout;
  must("tar", ["x", "-C", srcDir], { input: archive });
  const cdxgenCommit = run("git", ["rev-parse", "--short", opts.ref], {
    cwd: cdxgenRepo,
  }).stdout.trim();

  const shimDir = installPnpmShim();
  const store = path.join(outDir, "pnpm-store");
  const builds = {};
  for (const target of targets) {
    const timing = path.join(logDir, `${target}.caxa-ms`);
    rmSync(timing, { force: true });
    const env = {
      ...process.env,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
      CAXA_PACKAGE: caxaSpec,
      STANDALONE_TARGETS: target,
      STANDALONE_PNPM_STORE: store,
      CAXA_BENCH_TIMING: timing,
    };
    process.stdout.write(`build ${target} ... `);
    const [ms, res] = timeMs(() =>
      run("bash", [".github/scripts/build-standalone.sh"], {
        cwd: srcDir,
        env,
      }),
    );
    writeFileSync(
      path.join(logDir, `${target}.build.log`),
      `${res.stdout}\n${res.stderr}`,
    );
    const caxaMs = existsSync(timing)
      ? Number(readFileSync(timing, "utf8").trim().split("\n")[0])
      : null;
    const ok = res.status === 0 && existsSync(path.join(srcDir, target));
    if (ok) must("cp", [path.join(srcDir, target), path.join(binDir, target)]);
    builds[target] = {
      ok,
      exitCode: res.status,
      totalMs: Math.round(ms),
      caxaMs,
    };
    console.log(
      ok
        ? `ok (${(ms / 1000).toFixed(1)}s, caxa ${(caxaMs / 1000).toFixed(1)}s)`
        : `FAILED (exit ${res.status})`,
    );
  }
  return { cdxgenCommit, builds };
}

// ---------------------------------------------------------------------------
// 3. Size, payload and startup metrics
// ---------------------------------------------------------------------------

function measure(target) {
  const bin = path.join(binDir, target);
  const cache = path.join(workDir, "cache", target);
  // Prefetch off: the payload shape is what the cold start itself writes,
  // and the timings must not race a background prefetcher.
  const env = { ...process.env, CAXA_TEMP_DIR: cache, CAXA_PREFETCH: "0" };
  const version = () => run(bin, ["--version"], { env });

  // Payload shape from one fresh extraction.
  rmSync(cache, { recursive: true, force: true });
  const first = version();
  if (first.status !== 0) return { error: `--version exited ${first.status}` };
  const appsRoot = path.join(cache, "apps");
  const [id] = readdirSync(appsRoot);
  const payload = fileCountAndBytes(
    path.join(appsRoot, id, "0"),
    new Set([".node-compile-cache"]),
  );

  const cold = [];
  for (let i = 0; i < runs; i++) {
    rmSync(cache, { recursive: true, force: true });
    cold.push(timeMs(version)[0]);
  }
  version(); // populate the extraction and compile cache
  const warm = [];
  for (let i = 0; i < runs; i++) warm.push(timeMs(version)[0]);

  return {
    binaryBytes: statSync(bin).size,
    payloadFiles: payload.files,
    payloadBytes: payload.bytes,
    coldStartMs: stats(cold),
    warmStartMs: stats(warm),
  };
}

// ---------------------------------------------------------------------------
// 4. Feature smoke cases
// ---------------------------------------------------------------------------

// Inputs that no binary under test can produce for itself: a protobuf BOM for
// cdx-validate / cdx-convert, written with the cdxgen checkout's own
// lib/inventory/protobom.js (needs that checkout's node_modules).
function prepareFixtures() {
  const dir = path.join(workDir, "fixtures");
  mkdirSync(dir, { recursive: true });
  const protoBom = path.join(dir, "bom-cbom-js-fixture.cdx");
  const script = `
    import { readFileSync } from "node:fs";
    import { writeBinary } from ${JSON.stringify(path.join(cdxgenRepo, "lib/inventory/protobom.js"))};
    writeBinary(JSON.parse(readFileSync(${JSON.stringify(path.join(srcDir, "test/data/bom-cbom-js-fixture.json"))}, "utf8")), ${JSON.stringify(protoBom)});
  `;
  const res = run(process.execPath, ["--input-type=module", "-e", script]);
  if (res.status !== 0) {
    console.warn(
      `proto fixture unavailable (install deps in ${cdxgenRepo}): ${res.stderr.split("\n")[0]}`,
    );
    return {};
  }
  return { protoBom };
}

// Cases run with a minimal environment: no inherited *_CMD / CDXGEN_* / ATOM_*
// variables and no global node_modules or user PATH, so a globally installed
// plugin or atom cannot mask a payload missing from the binary.
function hermeticEnv(dir, target) {
  const keep = ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "TERM"];
  const env = Object.fromEntries(
    keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
  );
  return {
    ...env,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    GLOBAL_NODE_MODULES_PATH: "/nonexistent",
    CDXGEN_CACHE_DIR: path.join(dir, ".cdxgen-cache"),
    CAXA_TEMP_DIR: path.join(workDir, "cache", target),
  };
}

async function runSmoke(target, fixtures) {
  const results = [];
  for (const c of cases.filter((x) => x.target === target)) {
    if (c.platforms && !c.platforms.includes(process.platform)) {
      results.push({
        name: c.name,
        status: "skipped",
        reason: `not on ${process.platform}`,
      });
      continue;
    }
    const toolDirs = [];
    const missing = [];
    for (const tool of c.hostTools ?? []) {
      const found = run("sh", ["-c", `command -v ${tool}`]).stdout.trim();
      if (found) toolDirs.push(path.dirname(found));
      else missing.push(tool);
    }
    if (missing.length) {
      results.push({
        name: c.name,
        status: "skipped",
        reason: `host tool(s) not found: ${missing.join(", ")}`,
      });
      continue;
    }
    const dir = path.join(workDir, "smoke", target, c.name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const baseEnv = hermeticEnv(dir, target);
    // Declared host prerequisites only; everything else stays off PATH.
    if (toolDirs.length)
      baseEnv.PATH = [...new Set(toolDirs), baseEnv.PATH].join(path.delimiter);
    const ctx = {
      bin: path.join(binDir, target),
      src: srcDir,
      dir,
      fixtures,
      env: { ...baseEnv, ...c.env },
      run: (args, { bin, env, ...extra } = {}) =>
        run(bin ?? ctx.bin, args, {
          cwd: dir,
          timeout: (c.timeoutSec ?? 120) * 1000,
          ...extra,
          env: { ...ctx.env, ...env },
        }),
      extracted: () => {
        const apps = path.join(ctx.env.CAXA_TEMP_DIR, "apps");
        const [id] = readdirSync(apps);
        return path.join(apps, id, "0");
      },
      readJson: (p) => JSON.parse(readFileSync(path.resolve(dir, p), "utf8")),
      exists: (p) => existsSync(path.resolve(dir, p)),
    };
    const t0 = process.hrtime.bigint();
    let outcome;
    try {
      // Cases may be async; the prefetch case polls for its marker.
      outcome = (await c.check(ctx)) ?? {};
    } catch (e) {
      outcome = { failures: [String(e?.stack ?? e)] };
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const failures = outcome.failures ?? [];
    results.push({
      name: c.name,
      status: failures.length ? "failed" : "passed",
      ms: Math.round(ms),
      failures,
      // Normalised, deterministic facts compared against the baseline.
      fingerprint: outcome.fingerprint ?? null,
      // Facts worth reporting that differ by build, e.g. caxa lazy members.
      observations: outcome.observations ?? null,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 5. Report and baseline comparison
// ---------------------------------------------------------------------------

function pct(a, b) {
  if (a == null || b == null || b === 0) return "";
  const d = ((a - b) / b) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
}

function compare(current, baseline) {
  const regressions = [];
  for (const [target, cur] of Object.entries(current.targets)) {
    const base = baseline.targets[target];
    if (!base) continue;
    if (base.build?.ok && !cur.build.ok)
      regressions.push(`${target}: build now fails`);
    for (const s of cur.smoke ?? []) {
      const b = (base.smoke ?? []).find((x) => x.name === s.name);
      if (!b) continue;
      if (
        b.status === "passed" &&
        s.status !== "passed" &&
        s.status !== "skipped"
      ) {
        regressions.push(`${target}/${s.name}: was passing, now ${s.status}`);
      }
      if (
        b.fingerprint &&
        s.fingerprint &&
        JSON.stringify(b.fingerprint) !== JSON.stringify(s.fingerprint)
      ) {
        regressions.push(`${target}/${s.name}: output fingerprint changed`);
      }
    }
  }
  return regressions;
}

function markdown(current, baseline, regressions) {
  const b = (t) => baseline?.targets?.[t];
  const lines = [
    `# caxa bench: ${current.caxa}`,
    "",
    `cdxgen ${current.cdxgenCommit} · ${current.platform} · node ${current.node} · ${current.runs} runs · ${current.date}`,
    baseline ? `\nBaseline: ${baseline.caxa} (${baseline.date})` : "",
    "",
    "| Target | Build | caxa s | Size MiB | Files | Cold ms (median) | Warm ms (median) | Smoke |",
    "|---|---|---:|---:|---:|---:|---:|---|",
  ];
  for (const [t, r] of Object.entries(current.targets)) {
    const m = r.metrics ?? {};
    const smoke = r.smoke ?? [];
    const passed = smoke.filter((s) => s.status === "passed").length;
    const failed = smoke.filter((s) => s.status === "failed").length;
    const cell = (v, bv, fmt = (x) => x) =>
      v == null
        ? "–"
        : `${fmt(v)}${baseline && bv != null ? ` (${pct(v, bv)})` : ""}`;
    lines.push(
      `| ${t} | ${r.build.ok ? "ok" : "**FAIL**"} | ${cell(r.build.caxaMs, b(t)?.build?.caxaMs, (x) => (x / 1000).toFixed(1))} | ${cell(m.binaryBytes, b(t)?.metrics?.binaryBytes, (x) => (x / 1048576).toFixed(2))} | ${cell(m.payloadFiles, b(t)?.metrics?.payloadFiles)} | ${cell(m.coldStartMs?.median, b(t)?.metrics?.coldStartMs?.median)} | ${cell(m.warmStartMs?.median, b(t)?.metrics?.warmStartMs?.median)} | ${passed} passed${failed ? `, **${failed} failed**` : ""} |`,
    );
  }
  const failures = Object.entries(current.targets).flatMap(([t, r]) =>
    (r.smoke ?? [])
      .filter((s) => s.status === "failed")
      .map((s) => `- ${t}/${s.name}: ${s.failures.join("; ").slice(0, 500)}`),
  );
  if (failures.length) lines.push("", "## Smoke failures", "", ...failures);
  if (baseline)
    lines.push(
      "",
      "## Regressions vs baseline",
      "",
      ...(regressions.length ? regressions.map((r) => `- ${r}`) : ["None."]),
    );
  lines.push(
    "",
    "Cold start = `--version` with an empty extraction cache (extraction + first run). Warm start = `--version` with the cache populated. Page cache is not dropped between runs.",
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------

const caxa = prepareCaxaPackage();
console.log(
  `caxa under test: ${caxa.label}\ncdxgen: ${cdxgenRepo} (${opts.ref})\nout: ${outDir}`,
);

let buildInfo;
let prev = null;
const previous = path.join(outDir, "results.json");
if (opts["skip-build"]) {
  if (!existsSync(previous))
    throw new Error("--skip-build needs an existing results.json in --out");
  prev = JSON.parse(readFileSync(previous, "utf8"));
  buildInfo = {
    cdxgenCommit: prev.cdxgenCommit,
    builds: Object.fromEntries(
      Object.entries(prev.targets).map(([t, r]) => [t, r.build]),
    ),
  };
} else {
  buildInfo = buildTargets(caxa.spec);
}

const current = {
  caxa: caxa.label,
  cdxgenCommit: buildInfo.cdxgenCommit,
  platform: `${process.platform}-${process.arch}`,
  cpus: os.cpus().length,
  node: process.version,
  runs,
  date: new Date().toISOString(),
  // Re-measuring a subset keeps the other targets' earlier results.
  targets: prev ? { ...prev.targets } : {},
};

const fixtures = opts["skip-smoke"] ? {} : prepareFixtures();
for (const target of targets) {
  let build = buildInfo.builds[target] ?? { ok: false };
  if (opts["skip-build"] && !build.ok && existsSync(path.join(binDir, target)))
    build = { ok: true, reused: true };
  const entry = { build };
  if (build.ok) {
    process.stdout.write(`measure ${target} ... `);
    entry.metrics = measure(target);
    console.log(
      entry.metrics.error ??
        `cold ${entry.metrics.coldStartMs.median} ms, warm ${entry.metrics.warmStartMs.median} ms`,
    );
    if (!opts["skip-smoke"]) {
      entry.smoke = await runSmoke(target, fixtures);
      for (const s of entry.smoke)
        console.log(
          `  ${s.status.padEnd(7)} ${target}/${s.name}${s.failures?.length ? `: ${s.failures[0].slice(0, 200)}` : ""}`,
        );
    }
  }
  current.targets[target] = entry;
}

const baseline = opts.baseline
  ? JSON.parse(readFileSync(path.resolve(opts.baseline), "utf8"))
  : null;
const regressions = baseline ? compare(current, baseline) : [];
writeFileSync(previous, `${JSON.stringify(current, null, 2)}\n`);
writeFileSync(
  path.join(outDir, "summary.md"),
  markdown(current, baseline, regressions),
);
console.log(`\n${readFileSync(path.join(outDir, "summary.md"), "utf8")}`);

const anyFailure =
  Object.values(current.targets).some(
    (r) => !r.build.ok || (r.smoke ?? []).some((s) => s.status === "failed"),
  ) || regressions.length > 0;
process.exit(anyFailure ? 1 : 0);
