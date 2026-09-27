// Feature smoke cases for the cdxgen standalone binaries.
//
// Each case proves that the features its target's dependency profile bundles
// actually work inside the packaged binary. Where a feature depends on a
// bundled optional package or plugin, the case also runs a negative control
// (the plugin's *_CMD pointed at `false`) so a silent fallback cannot pass.
//
// check(ctx) returns { failures: string[], fingerprint?: object }. The
// fingerprint holds only deterministic, path-independent facts; run.mjs
// compares it against the baseline to catch behaviour changes.
//
// ctx: { bin, src, dir, fixtures, env, run(args, {env,cwd}), readJson(p),
//        exists(p), extracted() }
// All cases are offline and run from a fresh working directory with a
// sanitised environment (see run.mjs).

import { createHash, generateKeyPairSync } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const FALSE = "/usr/bin/false";

function checker() {
  const failures = [];
  return {
    failures,
    expect(cond, msg) {
      if (!cond) failures.push(msg);
      return cond;
    },
  };
}

function exitOk(t, res, what) {
  return t.expect(
    res.status === 0,
    `${what} exited ${res.status}: ${(res.stderr || res.stdout).slice(-400)}`,
  );
}

// Copy a fixture out of the source tree so outputs land in the case dir.
function fixture(ctx, rel, name = path.basename(rel)) {
  const dest = path.join(ctx.dir, name);
  cpSync(path.join(ctx.src, rel), dest, { recursive: true });
  return dest;
}

const components = (bom) => bom.components ?? [];
const hasProp = (c, name) => (c.properties ?? []).some((p) => p.name === name);
const hasPropPrefix = (c, prefix) =>
  (c.properties ?? []).some((p) => p.name.startsWith(prefix));
const digest = (list) =>
  createHash("sha256")
    .update(JSON.stringify([...list].sort()))
    .digest("hex")
    .slice(0, 16);
const purlSet = (bom) =>
  components(bom).map(
    (c) => c.purl ?? `${c.type}:${c.group ?? ""}/${c.name}@${c.version ?? ""}`,
  );
const fp = (bom) => ({
  components: components(bom).length,
  purls: digest(purlSet(bom)),
});

function countBy(list, key) {
  const out = {};
  for (const x of list) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

// Plugin directories inside the extracted payload, e.g. ["osquery", "trivy"].
function bundledPlugins(ctx) {
  const nm = path.join(ctx.extracted(), "node_modules", "@cdxgen");
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(nm).filter((d) => d.startsWith("cdxgen-plugins-bin"));
  } catch {
    return found;
  }
  for (const pkg of entries) {
    try {
      for (const e of readdirSync(path.join(nm, pkg, "plugins")))
        if (e !== "plugins-manifest.json") found.push(e);
    } catch {
      // package without a plugins dir
    }
  }
  return found.sort();
}

// Files of one extracted plugin, relative to the payload root.
function pluginFiles(ctx, plugin) {
  const nm = path.join(ctx.extracted(), "node_modules", "@cdxgen");
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) out.push(path.relative(ctx.extracted(), full));
    }
  };
  for (const pkg of readdirSync(nm).filter((d) =>
    d.startsWith("cdxgen-plugins-bin-"),
  )) {
    try {
      walk(path.join(nm, pkg, "plugins", plugin));
    } catch {
      // plugin not in this package
    }
  }
  return out.sort();
}

// caxa lazy members are extracted as placeholders: a stub copy ending in
// "CAXALZY1". Returns the plugin's files that are still placeholders.
function lazyPlaceholders(ctx, plugin) {
  return pluginFiles(ctx, plugin).filter((rel) => {
    const fd = openSync(path.join(ctx.extracted(), rel), "r");
    try {
      const { size } = fstatSync(fd);
      if (size < 8) return false;
      const magic = Buffer.alloc(8);
      readSync(fd, magic, 0, 8, size - 8);
      return magic.toString("latin1") === "CAXALZY1";
    } finally {
      closeSync(fd);
    }
  });
}

function hasPackage(ctx, name) {
  try {
    readFileSync(
      path.join(ctx.extracted(), "node_modules", name, "package.json"),
    );
    return true;
  } catch {
    return false;
  }
}

// Alpine rootfs synthesised from committed fixtures: trivy inventories apk.
function alpineRootfs(ctx) {
  const root = path.join(ctx.dir, "afs");
  mkdirSync(path.join(root, "etc"), { recursive: true });
  mkdirSync(path.join(root, "lib", "apk", "db"), { recursive: true });
  writeFileSync(path.join(root, "etc", "alpine-release"), "3.19.1\n");
  writeFileSync(
    path.join(root, "etc", "os-release"),
    "ID=alpine\nVERSION_ID=3.19.1\n",
  );
  cpSync(
    path.join(ctx.src, "test/data/alpine-installed"),
    path.join(root, "lib", "apk", "db", "installed"),
  );
  return root;
}

function keypair(ctx) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const priv = path.join(ctx.dir, "ed.key");
  const pub = path.join(ctx.dir, "ed.pub");
  writeFileSync(priv, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeFileSync(pub, publicKey.export({ type: "spki", format: "pem" }));
  const other = generateKeyPairSync("ed25519").publicKey;
  const wrong = path.join(ctx.dir, "wrong.pub");
  writeFileSync(wrong, other.export({ type: "spki", format: "pem" }));
  return { priv, pub, wrong };
}

// ---------------------------------------------------------------------------
// Shared case bodies
// ---------------------------------------------------------------------------

// atom via `-t c` on a header-only tree: every component comes from atom.
function atomCParseDeps(ctx) {
  const t = checker();
  const src = fixture(ctx, "test/data/evinse-cpp-repotest");
  const env = { OSQUERY_CMD: FALSE }; // -t c also queries host dev packages via osquery
  const ctl = ctx.run(["-t", "c", src, "-o", "ctl.json", "--no-install-deps"], {
    env: { ...env, ATOM_CMD: FALSE },
  });
  const ctlCount = ctx.exists("ctl.json")
    ? components(ctx.readJson("ctl.json")).length
    : 0;
  t.expect(
    ctlCount === 0,
    `negative control (ATOM_CMD=false) produced ${ctlCount} components (status ${ctl.status})`,
  );
  const res = ctx.run(
    ["-t", "c", src, "-o", "c.json", "--no-install-deps", "--fail-on-error"],
    { env },
  );
  if (!exitOk(t, res, "atom -t c")) return t;
  const bom = ctx.readJson("c.json");
  t.expect(components(bom).length > 0, "atom produced no components");
  t.expect(
    components(bom).some(
      (c) => c.purl === "pkg:generic/openssl/evp#openssl/evp.h",
    ),
    "expected pkg:generic/openssl/evp#openssl/evp.h",
  );
  return { ...t, fingerprint: fp(bom) };
}

function jsLockfile(ctx, extraArgs = []) {
  const t = checker();
  const src = fixture(ctx, "test/data/mcp-repotest");
  const res = ctx.run([
    "-t",
    "js",
    src,
    "-o",
    "js.json",
    "--no-install-deps",
    ...extraArgs,
  ]);
  if (!exitOk(t, res, "-t js")) return t;
  const bom = ctx.readJson("js.json");
  t.expect(
    components(bom).filter((c) => c.purl?.startsWith("pkg:npm/")).length > 0,
    "no pkg:npm components",
  );
  return { ...t, fingerprint: fp(bom) };
}

function hbomDevices(ctx, { proto }) {
  const t = checker();
  const args = ["-o", "h.json"];
  if (proto) args.push("--export-proto", "--proto-bin-file", "h.cdx");
  const res = ctx.run(args);
  if (!exitOk(t, res, "hbom")) return t;
  const devices = components(ctx.readJson("h.json"));
  t.expect(devices.length > 0, "no hardware components");
  t.expect(
    devices.every(
      (c) => c.type === "device" && hasProp(c, "cdx:hbom:hardwareClass"),
    ),
    "every component should be a device with cdx:hbom:hardwareClass",
  );
  if (proto) t.expect(ctx.exists("h.cdx"), "--export-proto wrote no h.cdx");
  // Hardware classes are stable on one host; values (battery, rssi) are not.
  return {
    ...t,
    fingerprint: {
      classes: Object.keys(
        countBy(
          devices,
          (c) =>
            c.properties.find((p) => p.name === "cdx:hbom:hardwareClass").value,
        ),
      ).sort(),
    },
  };
}

function osqueryRuntime(ctx, args, file) {
  const t = checker();
  const ctl = ctx.run([...args, "-o", `ctl-${file}`], {
    env: { OSQUERY_CMD: FALSE },
  });
  // With caxa lazy members osquery is still a placeholder here; cdxgen's own
  // spawn below must materialize it.
  const lazyBefore = lazyPlaceholders(ctx, "osquery");
  const ctlOs = ctx.exists(`ctl-${file}`)
    ? components(ctx.readJson(`ctl-${file}`)).filter((c) =>
        hasProp(c, "cdx:osquery:category"),
      ).length
    : 0;
  t.expect(
    ctlOs === 0,
    `negative control (OSQUERY_CMD=false) produced ${ctlOs} osquery components (status ${ctl.status})`,
  );
  const res = ctx.run([...args, "-o", file]);
  if (!exitOk(t, res, args.join(" ") || "obom")) return t;
  const os = components(ctx.readJson(file)).filter((c) =>
    hasProp(c, "cdx:osquery:category"),
  );
  t.expect(
    os.length > 0,
    "osquery produced no cdx:osquery:category components",
  );
  const lazyAfter = lazyPlaceholders(ctx, "osquery");
  t.expect(
    lazyAfter.length === 0,
    `osquery placeholders left after the run: ${lazyAfter.join(", ")}`,
  );
  return {
    ...t,
    observations: { lazyBefore, lazyAfter },
  };
}

function requiresOptional(t, res, pkg, what) {
  const out = `${res.stdout}\n${res.stderr}`;
  t.expect(
    res.status !== 0 || out.includes(pkg),
    `${what}: expected a missing '${pkg}' error in the slim profile`,
  );
  t.expect(out.includes(pkg), `${what}: output does not mention ${pkg}`);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const cases = [
  // cdxgen: full profile (all optional packages and platform plugins)
  {
    target: "cdxgen",
    name: "cdxrs-version-probe",
    check(ctx) {
      const t = checker();
      const res = ctx.run(["--version", "--verbose"]);
      exitOk(t, res, "--version --verbose");
      t.expect(
        /cdxrs \d+\.\d+\.\d+ \(available\)/.test(res.stdout),
        "cdxrs not reported available",
      );
      const ctl = ctx.run(["--version", "--verbose"], {
        env: { CDXRS_CMD: FALSE },
      });
      t.expect(
        !/cdxrs \d+\.\d+\.\d+ \(available\)/.test(ctl.stdout),
        "negative control (CDXRS_CMD=false) still reports cdxrs available",
      );
      return t;
    },
  },
  {
    target: "cdxgen",
    name: "trivy-rootfs",
    check(ctx) {
      const t = checker();
      const root = alpineRootfs(ctx);
      const ctl = ctx.run(["-t", "rootfs", root, "-o", "ctl.json"], {
        env: { TRIVY_CMD: FALSE },
      });
      const ctlCount = ctx.exists("ctl.json")
        ? components(ctx.readJson("ctl.json")).length
        : 0;
      t.expect(
        ctlCount === 0,
        `negative control (TRIVY_CMD=false) produced ${ctlCount} components (status ${ctl.status})`,
      );
      const res = ctx.run(["-t", "rootfs", root, "-o", "r.json"]);
      if (!exitOk(t, res, "-t rootfs")) return t;
      const bom = ctx.readJson("r.json");
      const apk = components(bom).filter((c) =>
        c.purl?.startsWith("pkg:apk/alpine/"),
      );
      t.expect(
        apk.length >= 15,
        `expected >=15 pkg:apk/alpine components, got ${apk.length}`,
      );
      t.expect(
        components(bom).some((c) => hasPropPrefix(c, "aquasecurity:trivy:")),
        "no aquasecurity:trivy:* properties",
      );
      return { ...t, fingerprint: fp(bom) };
    },
  },
  { target: "cdxgen", name: "atom-c-parsedeps", check: atomCParseDeps },
  {
    // Prefetch stays on: poll for the marker, then the heavy members must be
    // real files, and atom output must match the CAXA_PREFETCH=0 run.
    target: "cdxgen",
    name: "prefetch-materializes",
    timeoutSec: 300,
    async check(ctx) {
      const t = checker();
      exitOk(t, ctx.run(["--version"]));
      const extracted = ctx.extracted();
      const marker = path.join(extracted, ".caxa-prefetched");
      // No fixed sleeps: poll until the marker appears (or is already there).
      const deadline = Date.now() + 120000;
      while (!existsSync(marker)) {
        if (Date.now() > deadline) {
          t.failures.push(
            "the .caxa-prefetched marker did not appear within 120 s",
          );
          return t;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const memberReal = (rel) => {
        let fd;
        try {
          fd = openSync(path.join(extracted, rel), "r");
          const { size } = fstatSync(fd);
          if (size < 8) return false;
          const magic = Buffer.alloc(8);
          readSync(fd, magic, 0, 8, size - 8);
          return magic.toString("latin1") !== "CAXALZY1";
        } catch {
          return false;
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      };
      const atoms = readdirSync(
        path.join(extracted, "node_modules", "@appthreat"),
      )
        .filter((n) => /^atom-[a-z0-9]+-[a-z0-9]+$/.test(n))
        .map((n) => `node_modules/@appthreat/${n}/bin/atom`)
        .filter((rel) => existsSync(path.join(extracted, rel)));
      const members = [
        ...atoms,
        ...pluginFiles(ctx, "trivy").filter((rel) =>
          /\/trivy[A-Za-z0-9._-]*$/.test(rel),
        ),
      ].filter(Boolean);
      if (
        !t.expect(
          members.length >= 2,
          `atom or trivy not found in the payload: ${members.join(", ")}`,
        )
      )
        return t;
      for (const rel of members) {
        t.expect(
          memberReal(rel),
          `${rel} is still a placeholder after prefetch`,
        );
      }
      // Same work with and without prefetch must give the same BOM. Each run
      // gets a fresh copy: an atom scan leaves intermediates in its input,
      // so a second scan of the same tree is not the same work.
      const srcWarm = fixture(ctx, "test/data/evinse-cpp-repotest", "src-warm");
      const srcCold = fixture(ctx, "test/data/evinse-cpp-repotest", "src-cold");
      const env = { OSQUERY_CMD: FALSE };
      const warm = ctx.run(
        [
          "-t",
          "c",
          srcWarm,
          "-o",
          "warm.json",
          "--no-install-deps",
          "--fail-on-error",
        ],
        { env },
      );
      const cold = ctx.run(
        [
          "-t",
          "c",
          srcCold,
          "-o",
          "cold.json",
          "--no-install-deps",
          "--fail-on-error",
        ],
        {
          env: { ...env, CAXA_PREFETCH: "0" },
        },
      );
      exitOk(t, warm, "atom -t c (prefetch on)");
      exitOk(t, cold, "atom -t c (CAXA_PREFETCH=0)");
      if (ctx.exists("warm.json") && ctx.exists("cold.json")) {
        t.expect(
          fp(ctx.readJson("warm.json")).purls ===
            fp(ctx.readJson("cold.json")).purls,
          "atom output differs between the prefetch and CAXA_PREFETCH=0 runs",
        );
      }
      return t;
    },
  },
  {
    target: "cdxgen",
    name: "js-export-proto",
    check(ctx) {
      const t = checker();
      const r = jsLockfile(ctx, [
        "--export-proto",
        "--proto-bin-file",
        "js.cdx",
      ]);
      t.failures.push(...r.failures);
      t.expect(
        ctx.exists("js.cdx"),
        "--export-proto wrote no js.cdx (cdx-proto missing?)",
      );
      return { ...t, fingerprint: r.fingerprint };
    },
  },
  {
    target: "cdxgen",
    name: "payload-contents",
    check(ctx) {
      const t = checker();
      for (const p of [
        "@cdxgen/cdx-proto",
        "@cdxgen/cdx-hbom",
        "jsonata",
        "@appthreat/atom",
      ]) {
        t.expect(hasPackage(ctx, p), `${p} not bundled`);
      }
      const plugins = bundledPlugins(ctx);
      for (const p of ["osquery", "trivy"])
        t.expect(
          plugins.includes(p),
          `plugin ${p} not bundled (have: ${plugins.join(",")})`,
        );
      return { ...t, fingerprint: { plugins } };
    },
  },

  {
    // kosi needs OpenAPI inputs and a toolchain for real work; --help proves
    // the extracted binary (a caxa lazy member when built with CAXA_LAZY)
    // runs, and that running it leaves the real kosi in place. Prefetch is
    // off: this case pins the placeholder-before-run contract.
    target: "cdxgen",
    name: "kosi-help",
    env: { CAXA_PREFETCH: "0" },
    check(ctx) {
      const t = checker();
      exitOk(t, ctx.run(["--version"]), "--version");
      const [kosi] = pluginFiles(ctx, "kosi").filter((rel) =>
        /\/kosi-[a-z0-9]+-[a-z0-9]+(\.exe)?$/.test(rel),
      );
      if (!t.expect(kosi, "kosi binary not bundled")) return t;
      const full = path.join(ctx.extracted(), kosi);
      const placeholderBefore = lazyPlaceholders(ctx, "kosi").includes(kosi);
      const res = ctx.run(["--help"], { bin: full });
      exitOk(t, res, "kosi --help");
      t.expect(
        /kosi/i.test(`${res.stdout}${res.stderr}`),
        "kosi --help output does not mention kosi",
      );
      const placeholderAfter = lazyPlaceholders(ctx, "kosi").includes(kosi);
      t.expect(!placeholderAfter, "kosi is still a placeholder after running");
      const head = readFileSync(full).subarray(0, 4).toString("hex");
      t.expect(
        ["cffaedfe", "7f454c46"].includes(head) || head.startsWith("4d5a"),
        `kosi is not a native executable after running (magic ${head})`,
      );
      return {
        ...t,
        observations: {
          placeholderBefore,
          placeholderAfter,
          bytesAfter: statSync(full).size,
        },
      };
    },
  },

  // cdxgen-slim and aibom: no optional packages
  {
    target: "cdxgen-slim",
    name: "gguf-model",
    check(ctx) {
      const t = checker();
      const src = fixture(ctx, "test/data/gguf-ai-repotest");
      const res = ctx.run([
        "-t",
        "ai",
        src,
        "-o",
        "g.json",
        "--no-install-deps",
      ]);
      if (!exitOk(t, res, "-t ai")) return t;
      const bom = ctx.readJson("g.json");
      t.expect(
        components(bom).some((c) =>
          (c.properties ?? []).some(
            (p) => p.name === "cdx:gguf:sizeLabel" && p.value === "8x7B",
          ),
        ),
        "no model with cdx:gguf:sizeLabel=8x7B",
      );
      return { ...t, fingerprint: fp(bom) };
    },
  },
  {
    target: "cdxgen-slim",
    name: "js-mcp",
    check(ctx) {
      const t = checker();
      const src = fixture(ctx, "test/data/mcp-repotest");
      const res = ctx.run([
        "-t",
        "js",
        "-t",
        "mcp",
        src,
        "-o",
        "m.json",
        "--no-install-deps",
      ]);
      if (!exitOk(t, res, "-t js -t mcp")) return t;
      const bom = ctx.readJson("m.json");
      t.expect(
        (bom.services ?? []).length === 2,
        `expected 2 services, got ${(bom.services ?? []).length}`,
      );
      t.expect(
        [...components(bom), ...(bom.services ?? [])].some((c) =>
          hasPropPrefix(c, "cdx:mcp:"),
        ),
        "no cdx:mcp:* properties",
      );
      return {
        ...t,
        fingerprint: {
          ...fp(bom),
          services: (bom.services ?? []).map((s) => s.name).sort(),
        },
      };
    },
  },
  {
    target: "cdxgen-slim",
    name: "profile-excludes-optional",
    check(ctx) {
      const t = checker();
      for (const p of ["@cdxgen/cdx-proto", "jsonata", "@appthreat/atom"])
        t.expect(!hasPackage(ctx, p), `${p} should not be bundled`);
      t.expect(
        bundledPlugins(ctx).length === 0,
        "no plugins should be bundled",
      );
      const src = fixture(ctx, "test/data/mcp-repotest");
      const res = ctx.run([
        "-t",
        "js",
        src,
        "-o",
        "p.json",
        "--no-install-deps",
        "--export-proto",
      ]);
      requiresOptional(t, res, "@cdxgen/cdx-proto", "--export-proto");
      return t;
    },
  },
  {
    target: "aibom",
    name: "huggingface-model",
    check(ctx) {
      const t = checker();
      const src = fixture(ctx, "test/data/ai-huggingface/repos", "repos");
      const res = ctx.run([src, "-o", "ai.json", "--no-install-deps"]);
      if (!exitOk(t, res, "aibom")) return t;
      const bom = ctx.readJson("ai.json");
      t.expect(
        components(bom).some(
          (c) =>
            c.type === "machine-learning-model" &&
            c.group === "HuggingFaceH4" &&
            c.name === "zephyr-7b-beta",
        ),
        "no HuggingFaceH4/zephyr-7b-beta machine-learning-model",
      );
      // aibom forces formulation (random refs): fingerprint only the models.
      const models = components(bom)
        .filter((c) => c.type === "machine-learning-model")
        .map((c) => `${c.group}/${c.name}`);
      return {
        ...t,
        fingerprint: { models: digest(models), count: models.length },
      };
    },
  },

  // cbom and saasbom: atom-analysis profile
  { target: "cbom", name: "atom-c-parsedeps", check: atomCParseDeps },
  {
    target: "cbom",
    name: "js-crypto-assets",
    timeoutSec: 180,
    check(ctx) {
      const t = checker();
      const src = fixture(ctx, "test/data/cbom-js-repotest");
      const res = ctx.run([src, "-o", "cb.json", "--no-install-deps"]);
      if (!exitOk(t, res, "cbom")) return t;
      const bom = ctx.readJson("cb.json");
      const assets = components(bom).filter(
        (c) => c.type === "cryptographic-asset",
      );
      t.expect(
        assets.some(
          (c) => c.name === "sha-384" && hasProp(c, "cdx:crypto:sourceType"),
        ),
        "no sha-384 cryptographic-asset with cdx:crypto:sourceType",
      );
      return {
        ...t,
        fingerprint: {
          assets: digest(assets.map((c) => c.name)),
          count: assets.length,
        },
      };
    },
  },
  {
    target: "saasbom",
    name: "atom-js-usages",
    timeoutSec: 180,
    check(ctx) {
      // saasbom turns on evidence/deep; atom writes the usages slices. Services
      // are an evinse concern, so the slices are the proof that atom ran.
      const t = checker();
      const src = fixture(ctx, "test/data/mcp-repotest");
      const args = ["-t", "js", src, "--no-install-deps"];
      ctx.run(
        [...args, "-o", "ctl.json", "--usages-slices-file", "ctl-u.json"],
        { env: { ATOM_CMD: FALSE } },
      );
      t.expect(
        !ctx.exists("ctl-u.json"),
        "negative control (ATOM_CMD=false) still wrote usages slices",
      );
      const res = ctx.run([
        ...args,
        "-o",
        "s.json",
        "--usages-slices-file",
        "u.json",
      ]);
      if (!exitOk(t, res, "saasbom -t js")) return t;
      if (!t.expect(ctx.exists("u.json"), "no usages slices written")) return t;
      const u = ctx.readJson("u.json");
      t.expect(
        (u.objectSlices ?? []).length > 0,
        "usages slices have no objectSlices",
      );
      return {
        ...t,
        fingerprint: {
          objectSlices: (u.objectSlices ?? []).length,
          userDefinedTypes: (u.userDefinedTypes ?? []).length,
        },
      };
    },
  },
  {
    target: "saasbom",
    name: "atom-parsetools-php",
    timeoutSec: 180,
    // atom-parsetools' php-parse is PHP code: a host php is a documented prerequisite.
    hostTools: ["php"],
    check(ctx) {
      const t = checker();
      const src = fixture(ctx, "test/data/evinse-php-repotest");
      const res = ctx.run([
        "-t",
        "php",
        src,
        "-o",
        "p.json",
        "--no-install-deps",
        "--usages-slices-file",
        "p-u.json",
      ]);
      if (!exitOk(t, res, "saasbom -t php")) return t;
      t.expect(
        ctx.exists("p-u.json"),
        "no php usages slices (atom-parsetools php-parse missing?)",
      );
      t.expect(ctx.exists("php-app.atom"), "no php-app.atom");
      return t;
    },
  },

  // obom: osquery everywhere, trustinspector on darwin/windows
  {
    target: "obom",
    name: "osquery-runtime",
    timeoutSec: 600,
    // Prefetch off: the case asserts the placeholder before osquery runs.
    env: { CAXA_PREFETCH: "0" },
    check: (ctx) => osqueryRuntime(ctx, [], "o.json"),
  },
  {
    target: "obom",
    name: "trustinspector",
    platforms: ["darwin"],
    timeoutSec: 600,
    check(ctx) {
      const t = checker();
      const ctl = ctx.run(["-o", "ctl.json"], {
        env: { TRUSTINSPECTOR_CMD: FALSE },
      });
      const kind = (f) =>
        components(ctx.readJson(f)).some((c) =>
          hasProp(c, "cdx:trustinspector:kind"),
        );
      t.expect(
        !(ctx.exists("ctl.json") && kind("ctl.json")),
        `negative control (TRUSTINSPECTOR_CMD=false) still has trustinspector data (status ${ctl.status})`,
      );
      const res = ctx.run(["-o", "o.json"]);
      if (!exitOk(t, res, "obom")) return t;
      t.expect(kind("o.json"), "no cdx:trustinspector:kind properties");
      return t;
    },
  },

  // hbom: cdx-hbom + cdx-proto + osquery
  {
    target: "hbom",
    name: "devices-export-proto",
    check: (ctx) => hbomDevices(ctx, { proto: true }),
  },
  {
    target: "hbom",
    name: "include-runtime-osquery",
    timeoutSec: 600,
    env: { CAXA_PREFETCH: "0" },
    check: (ctx) => osqueryRuntime(ctx, ["--include-runtime"], "hr.json"),
  },
  {
    target: "hbom",
    name: "diagnostics",
    check(ctx) {
      const t = checker();
      if (!exitOk(t, ctx.run(["-o", "h.json"]), "hbom")) return t;
      const res = ctx.run(["diagnostics", "--input", "h.json", "--json"]);
      if (!exitOk(t, res, "hbom diagnostics")) return t;
      t.expect(
        Boolean(JSON.parse(res.stdout).collectorProfile),
        "diagnostics JSON has no collectorProfile",
      );
      return t;
    },
  },

  // hbom-slim: cdx-hbom only
  {
    target: "hbom-slim",
    name: "devices",
    check: (ctx) => hbomDevices(ctx, { proto: false }),
  },
  {
    target: "hbom-slim",
    name: "profile-excludes-optional",
    check(ctx) {
      const t = checker();
      t.expect(
        !hasPackage(ctx, "@cdxgen/cdx-proto"),
        "@cdxgen/cdx-proto should not be bundled",
      );
      t.expect(
        bundledPlugins(ctx).length === 0,
        "no plugins should be bundled",
      );
      requiresOptional(
        t,
        ctx.run(["-o", "p.json", "--export-proto"]),
        "@cdxgen/cdx-proto",
        "--export-proto",
      );
      return t;
    },
  },

  // cdx-audit: jsonata
  {
    target: "cdx-audit",
    name: "direct-bom-audit",
    check(ctx) {
      const t = checker();
      const bom = fixture(ctx, "test/data/bom-cbom-js-fixture.json");
      const res = ctx.run([
        "--bom",
        bom,
        "--direct-bom-audit",
        "--report",
        "json",
        "-o",
        "a.json",
      ]);
      t.expect(
        res.status === 3,
        `expected exit 3 (findings), got ${res.status}: ${res.stderr.slice(-300)}`,
      );
      if (!ctx.exists("a.json"))
        return { ...t, failures: [...t.failures, "no report written"] };
      const report = ctx.readJson("a.json");
      t.expect(
        report.auditMode === "direct",
        `auditMode is ${report.auditMode}`,
      );
      const ruleIds = [];
      JSON.stringify(report, (k, v) => {
        if (k === "ruleId") ruleIds.push(v);
        return v;
      });
      t.expect(ruleIds.includes("CHE-006"), "rule CHE-006 not reported");
      const low = ctx.run([
        "--bom",
        bom,
        "--direct-bom-audit",
        "--report",
        "json",
        "-o",
        "b.json",
        "--fail-severity",
        "critical",
        "--categories",
        "ci-permission",
      ]);
      t.expect(
        low.status === 0,
        `--fail-severity critical --categories ci-permission exited ${low.status}`,
      );
      return {
        ...t,
        fingerprint: {
          totalFindings: report.summary?.totalFindings,
          rules: [...new Set(ruleIds)].sort(),
        },
      };
    },
  },

  // cdx-sign and cdx-verify: json-signature profile
  {
    target: "cdx-sign",
    name: "sign-ed25519",
    check(ctx) {
      const t = checker();
      const k = keypair(ctx);
      const bom = fixture(ctx, "test/data/bom-java.json");
      const res = ctx.run([
        "-i",
        bom,
        "-o",
        "signed.json",
        "-k",
        k.priv,
        "-a",
        "Ed25519",
      ]);
      if (!exitOk(t, res, "cdx-sign")) return t;
      const signed = ctx.readJson("signed.json");
      t.expect(
        signed.signature?.algorithm === "Ed25519",
        "BOM signature algorithm is not Ed25519",
      );
      t.expect(
        components(signed).some((c) => c.signature),
        "no component signatures",
      );
      return t;
    },
  },
  {
    target: "cdx-verify",
    name: "verify-and-tamper",
    // cdx-verify cannot sign; sign in-process with node:crypto is not JSF, so
    // use the committed signed fixture only if present, else sign via the
    // cdx-sign binary when it was built in the same run.
    check(ctx) {
      const t = checker();
      const signer = path.join(path.dirname(ctx.bin), "cdx-sign");
      const k = keypair(ctx);
      const bom = fixture(ctx, "test/data/bom-java.json");
      const s = ctx.run(
        ["-i", bom, "-o", "signed.json", "-k", k.priv, "-a", "Ed25519"],
        { bin: signer },
      );
      if (s.error || s.status !== 0)
        return {
          failures: [
            `needs the cdx-sign binary from the same run (status ${s.status})`,
          ],
        };
      const ok = ctx.run(["-i", "signed.json", "--public-key", k.pub]);
      t.expect(ok.status === 0, `valid signature rejected (exit ${ok.status})`);
      const wrong = ctx.run(["-i", "signed.json", "--public-key", k.wrong]);
      t.expect(
        wrong.status !== 0,
        "signature accepted with the wrong public key",
      );
      const tampered = ctx.readJson("signed.json");
      const c = components(tampered).find((x) => x.signature && x.version);
      if (
        t.expect(Boolean(c), "no signed component with a version to tamper")
      ) {
        c.version = `${c.version}-tampered`;
        writeFileSync(
          path.join(ctx.dir, "tampered.json"),
          JSON.stringify(tampered),
        );
        const bad = ctx.run(["-i", "tampered.json", "--public-key", k.pub]);
        t.expect(bad.status !== 0, "tampered BOM accepted");
      }
      return t;
    },
  },

  // cdx-validate and cdx-convert: proto-reader profile
  {
    target: "cdx-validate",
    name: "validate-json-and-proto",
    check(ctx) {
      const t = checker();
      const json = fixture(ctx, "test/data/bom-cbom-js-fixture.json");
      const res = ctx.run([
        "-i",
        json,
        "--no-deep",
        "--report",
        "json",
        "-o",
        "v.json",
        "--fail-severity",
        "critical",
      ]);
      exitOk(t, res, "cdx-validate json");
      const v = ctx.exists("v.json") ? ctx.readJson("v.json") : {};
      t.expect(v.schemaValid === true, "JSON fixture is not schema-valid");
      if (!ctx.fixtures?.protoBom)
        return {
          ...t,
          failures: [...t.failures, "proto fixture unavailable (see run.mjs)"],
        };
      const pres = ctx.run([
        "-i",
        ctx.fixtures.protoBom,
        "--no-deep",
        "--report",
        "json",
        "-o",
        "vp.json",
        "--fail-severity",
        "critical",
      ]);
      exitOk(t, pres, "cdx-validate proto");
      const vp = ctx.exists("vp.json") ? ctx.readJson("vp.json") : {};
      t.expect(typeof vp.schemaValid === "boolean", "protobuf BOM not read");
      // Proto schemaValid is false today (dependsOn round-trip); pin it so a change shows up.
      return {
        ...t,
        fingerprint: { json: v.schemaValid, proto: vp.schemaValid },
      };
    },
  },
  {
    target: "cdx-convert",
    name: "proto-to-spdx",
    check(ctx) {
      const t = checker();
      if (!ctx.fixtures?.protoBom)
        return { failures: ["proto fixture unavailable (see run.mjs)"] };
      const res = ctx.run(["-i", ctx.fixtures.protoBom, "-o", "f.spdx.json"]);
      if (!exitOk(t, res, "cdx-convert proto")) return t;
      const spdx = ctx.readJson("f.spdx.json");
      t.expect(
        String(spdx["@context"]).endsWith("spdx-context.jsonld"),
        "not SPDX 3 JSON-LD",
      );
      const pkgs = (spdx["@graph"] ?? []).filter(
        (x) => x.type === "software_Package",
      ).length;
      t.expect(pkgs > 0, "no software_Package entries");
      return { ...t, fingerprint: { packages: pkgs } };
    },
  },
  {
    target: "cdx-convert",
    name: "json-to-cdx-1.5",
    check(ctx) {
      const t = checker();
      const bom = fixture(ctx, "test/data/bom-cbom-js-fixture.json");
      const res = ctx.run(["-i", bom, "--to", "1.5", "-o", "b15.json"]);
      if (!exitOk(t, res, "cdx-convert --to 1.5")) return t;
      const out = ctx.readJson("b15.json");
      t.expect(out.specVersion === "1.5", `specVersion is ${out.specVersion}`);
      return { ...t, fingerprint: { components: components(out).length } };
    },
  },

  // tracebom: safer-exec
  {
    target: "tracebom",
    name: "trace-ls",
    platforms: ["linux"],
    check(ctx) {
      const t = checker();
      const res = ctx.run(["--cmd", "ls /", "-o", "t.json"]);
      if (!exitOk(t, res, "tracebom")) return t;
      const libs = components(ctx.readJson("t.json")).filter((c) =>
        hasProp(c, "cdx:dynamic:filePath"),
      );
      t.expect(
        libs.length > 0,
        "no traced libraries (safer-exec missing? tracebom exits 0 with an empty BOM)",
      );
      return t;
    },
  },
  {
    target: "tracebom",
    name: "sandbox-write-policy",
    platforms: ["darwin", "linux"],
    check(ctx) {
      // If safer-exec is missing the command never runs, so `ok` is never created.
      const t = checker();
      const allow = path.join(ctx.dir, "allow");
      const deny = path.join(ctx.dir, "deny");
      mkdirSync(allow);
      mkdirSync(deny);
      const res = ctx.run([
        "--cmd",
        `/usr/bin/touch ${allow}/ok`,
        "--write-paths",
        allow,
        "-o",
        "a.json",
      ]);
      exitOk(t, res, "tracebom allowed write");
      t.expect(
        ctx.exists("allow/ok"),
        "allowed write did not happen: the traced command never ran",
      );
      ctx.run([
        "--cmd",
        `/usr/bin/touch ${deny}/x`,
        "--write-paths",
        allow,
        "-o",
        "d.json",
      ]);
      t.expect(
        !ctx.exists("deny/x"),
        "write outside --write-paths was not blocked",
      );
      return t;
    },
  },
];
