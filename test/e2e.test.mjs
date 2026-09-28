import { test } from "node:test";
import assert from "node:assert";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import zlib from "node:zlib";
import fs from "fs";
import path from "path";

function withPrefixedPath(prefix, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";

  for (const key of Object.keys(env)) {
    if (key !== pathKey && key.toLowerCase() === "path") {
      delete env[key];
    }
  }

  env[pathKey] = `${prefix}${path.delimiter}${currentPath}`;
  return env;
}

test("caxa v3 cli: help and version", async () => {
  const helpOutput = execFileSync(
    process.execPath,
    ["build/index.mjs", "--help"],
    {
      encoding: "utf8",
    },
  );
  assert.match(helpOutput, /Usage: caxa \[options\] \[command\.\.\.\]/);
  assert.match(helpOutput, /--targets-file <path>/);

  const versionOutput = execFileSync(
    process.execPath,
    ["build/index.mjs", "--version"],
    {
      encoding: "utf8",
    },
  ).trim();
  const packageVersion = JSON.parse(
    fs.readFileSync(path.resolve("package.json"), "utf8"),
  ).version;
  assert.equal(versionOutput, packageVersion);
});

test("caxa v3 e2e: globby exclude patterns and directories", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-excludes");
  const outputBin = path.resolve(
    "test-output-excludes" + (process.platform === "win32" ? ".exe" : ""),
  );
  const metadataPath = path.resolve("binary-metadata-excludes.json");

  if (fs.existsSync(fixtureDir))
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (fs.existsSync(outputBin)) fs.unlinkSync(outputBin);
  if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);

  fs.mkdirSync(path.join(fixtureDir, "node_modules", "dummy-lib"), {
    recursive: true,
  });

  fs.mkdirSync(path.join(fixtureDir, "secrets"), { recursive: true });
  fs.mkdirSync(path.join(fixtureDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(fixtureDir, "nested", "deep", "ignored"), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "@appthreat/test-app",
      version: "2.5.0",
      description: "Test for explicit exclusions",
      dependencies: {
        "dummy-lib": "^1.0.1",
      },
    }),
  );

  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "dummy-lib", "package.json"),
    JSON.stringify({ name: "dummy-lib", version: "1.0.1" }),
  );

  fs.writeFileSync(
    path.join(fixtureDir, "src", "main.js"),
    "console.log('main');",
  );

  fs.writeFileSync(path.join(fixtureDir, "secrets", "api-key.txt"), "secret");
  fs.writeFileSync(path.join(fixtureDir, "secrets", "config.json"), "secret");
  fs.writeFileSync(path.join(fixtureDir, "debug.log"), "logfile");
  fs.writeFileSync(path.join(fixtureDir, "src", "error.log"), "nested logfile");
  fs.writeFileSync(
    path.join(fixtureDir, "nested", "deep", "ignored", "data.bin"),
    "deep data",
  );

  const runtimeScript = `
    const fs = require('fs');
    const path = require('path');

    function getAllFiles(dirPath, arrayOfFiles) {
      files = fs.readdirSync(dirPath);
      arrayOfFiles = arrayOfFiles || [];

      files.forEach(function(file) {
        if (fs.statSync(dirPath + "/" + file).isDirectory()) {
          arrayOfFiles = getAllFiles(dirPath + "/" + file, arrayOfFiles);
        } else {
          const relPath = path.relative(__dirname, path.join(dirPath, file)).replace(/\\\\/g, '/');
          arrayOfFiles.push(relPath);
        }
      });
      return arrayOfFiles;
    }

    console.log("CAXA_V2_RUNNING");
    
    try {
      const files = getAllFiles(__dirname);
      console.log("runtime_files::" + JSON.stringify(files));
    } catch(e) {
      console.error(e);
    }
  `;

  fs.writeFileSync(path.join(fixtureDir, "index.js"), runtimeScript);

  execFileSync(
    process.execPath,
    [
      "build/index.mjs",
      "-i",
      fixtureDir,
      "-o",
      outputBin,
      "--no-include-node",
      "--exclude",
      "secrets",
      "**/*.log",
      "nested/deep/ignored",
      "--",
      process.execPath,
      "{{caxa}}/index.js",
    ],
    { stdio: "inherit" },
  );

  if (fs.existsSync("binary-metadata.json")) {
    fs.renameSync("binary-metadata.json", metadataPath);
  }
  const metadataObj = JSON.parse(fs.readFileSync(metadataPath));
  assert.ok(metadataObj.parentComponent);
  assert.equal(
    metadataObj.parentComponent["bom-ref"],
    "pkg:generic/@appthreat/test-app@2.5.0",
  );
  assert.ok(metadataObj.components);
  assert.ok(
    metadataObj.components.some((component) => component.name === "dummy-lib"),
  );
  assert.ok(metadataObj.dependencies);

  let filesFound = [];
  try {
    const stdout = execFileSync(outputBin, [], { encoding: "utf8" });

    assert.match(
      stdout,
      /CAXA_V2_RUNNING/,
      "Binary did not produce expected output",
    );

    const match = stdout.match(/runtime_files::(.*)/);
    assert.ok(match, "Could not retrieve file list from binary execution");
    filesFound = JSON.parse(match[1]);
  } catch (e) {
    assert.fail("Binary execution failed");
  }

  assert.ok(
    filesFound.includes("package.json"),
    "package.json should be present",
  );
  assert.ok(filesFound.includes("index.js"), "index.js should be present");
  assert.ok(
    filesFound.includes("src/main.js"),
    "src/main.js should be present",
  );

  assert.strictEqual(
    filesFound.some((f) => f.startsWith("secrets/")),
    false,
    "Secrets directory should be excluded",
  );

  assert.strictEqual(
    filesFound.includes("debug.log"),
    false,
    "Root log file should be excluded",
  );
  assert.strictEqual(
    filesFound.includes("src/error.log"),
    false,
    "Nested log file should be excluded",
  );

  assert.strictEqual(
    filesFound.some((f) => f.includes("nested/deep/ignored/")),
    false,
    "Deeply nested ignored directory should be excluded",
  );

  cleanup(fixtureDir, outputBin, metadataPath);
});

test("caxa v3 default excludes: node_modules docs, tests, maps, declarations, and markdown", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-default-excludes");
  const outputBin = path.resolve(
    "test-output-default-excludes" +
      (process.platform === "win32" ? ".exe" : ""),
  );

  for (const candidate of [
    fixtureDir,
    outputBin,
    path.resolve("binary-metadata.json"),
  ]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(path.join(fixtureDir, "node_modules", "pkg", "dist"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(fixtureDir, "node_modules", "pkg", "docs"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(fixtureDir, "node_modules", "pkg", "tests"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(fixtureDir, "node_modules", "pkg", "examples"), {
    recursive: true,
  });

  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "default-excludes-app", version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "index.js"),
    [
      "const fs = require('fs');",
      "const path = require('path');",
      "const walk = (dir, out = []) => {",
      "  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {",
      "    const abs = path.join(dir, entry.name);",
      "    if (entry.isDirectory()) walk(abs, out);",
      "    else out.push(path.relative(__dirname, abs).replace(/\\\\/g, '/'));",
      "  }",
      "  return out.sort();",
      "};",
      "console.log('DEFAULT_EXCLUDES::' + JSON.stringify(walk(__dirname)));",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "pkg", "package.json"),
    JSON.stringify({ name: "pkg", version: "1.0.0", main: "dist/index.js" }),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "pkg", "dist", "index.js"),
    "module.exports = 'ok';",
  );
  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "pkg", "dist", "index.js.map"),
    "{}",
  );
  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "pkg", "dist", "index.d.ts"),
    "export {};",
  );
  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "pkg", "README.md"),
    "# pkg",
  );
  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "pkg", "CHANGELOG.md"),
    "initial release",
  );
  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "pkg", "docs", "guide.md"),
    "guide",
  );
  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "pkg", "tests", "index.test.js"),
    "throw new Error('should not ship');",
  );
  fs.writeFileSync(
    path.join(fixtureDir, "node_modules", "pkg", "examples", "demo.js"),
    "console.log('demo');",
  );

  execFileSync(
    process.execPath,
    [
      "build/index.mjs",
      "-i",
      fixtureDir,
      "-o",
      outputBin,
      "--no-include-node",
      "--",
      process.execPath,
      "{{caxa}}/index.js",
    ],
    { stdio: "inherit" },
  );

  const stdout = execFileSync(outputBin, [], { encoding: "utf8" });
  const match = stdout.match(/DEFAULT_EXCLUDES::(.*)/);
  assert.ok(match, "Expected runtime file list from packaged app");
  const files = JSON.parse(match[1]);

  assert.ok(files.includes("node_modules/pkg/package.json"));
  assert.ok(files.includes("node_modules/pkg/dist/index.js"));
  assert.strictEqual(
    files.includes("node_modules/pkg/dist/index.js.map"),
    false,
  );
  assert.strictEqual(files.includes("node_modules/pkg/dist/index.d.ts"), false);
  assert.strictEqual(files.includes("node_modules/pkg/README.md"), false);
  assert.strictEqual(files.includes("node_modules/pkg/CHANGELOG.md"), false);
  assert.strictEqual(
    files.some((file) => file.startsWith("node_modules/pkg/docs/")),
    false,
  );
  assert.strictEqual(
    files.some((file) => file.startsWith("node_modules/pkg/tests/")),
    false,
  );
  assert.strictEqual(
    files.some((file) => file.startsWith("node_modules/pkg/examples/")),
    false,
  );

  cleanup(fixtureDir, outputBin);
});

test("caxa v3 e2e: portable bundled Node runtime with zstd payloads", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-portable-node");
  const outputBin = path.resolve(
    "test-output-portable-node" + (process.platform === "win32" ? ".exe" : ""),
  );
  const metadataPath = path.resolve("binary-metadata-portable-node.json");

  for (const candidate of [fixtureDir, outputBin, metadataPath]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "portable-node-app",
      version: "1.0.0",
    }),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "index.js"),
    [
      "console.log('PORTABLE_NODE_OK');",
      "console.log('EXEC_PATH::' + process.execPath.replace(/\\\\/g, '/'));",
      "console.log('VERSION::' + process.version);",
    ].join("\n"),
  );

  execFileSync(
    process.execPath,
    [
      "build/index.mjs",
      "-i",
      fixtureDir,
      "-o",
      outputBin,
      "--compression",
      "zstd",
      "--",
      "{{caxa}}/node_modules/.bin/node",
      "{{caxa}}/index.js",
    ],
    { stdio: "inherit" },
  );

  if (fs.existsSync("binary-metadata.json")) {
    fs.renameSync("binary-metadata.json", metadataPath);
  }

  const stdout = execFileSync(outputBin, [], { encoding: "utf8" });
  assert.match(stdout, /PORTABLE_NODE_OK/);
  assert.match(stdout, /VERSION::v\d+/);

  const execPathMatch = stdout.match(/EXEC_PATH::(.*)/);
  assert.ok(execPathMatch, "Bundled Node execPath should be printed");
  assert.match(execPathMatch[1], /node_modules\/\.bin\//);

  const metadataObj = JSON.parse(fs.readFileSync(metadataPath));
  assert.ok(
    metadataObj.components.some((component) => component.name === "node"),
    "Bundled runtime metadata should include the Node component",
  );

  // Retries the EPERM Windows gives for an exe it still holds after a run.
  cleanup(fixtureDir, outputBin, metadataPath);
});

test(
  "caxa strip: the bundled Node executable is stripped, deterministically, unless --no-strip-node",
  {
    skip:
      process.platform === "win32"
        ? "Windows keeps Node's symbols in .pdb files"
        : false,
  },
  () => {
    const fixtureDir = path.resolve("test/e2e-fixture-strip");
    const nodePath = fs.realpathSync(process.execPath);
    const outputs = [];
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(
        path.join(fixtureDir, "package.json"),
        JSON.stringify({ name: "strip-app", version: "1.0.0" }),
      );
      fs.writeFileSync(
        path.join(fixtureDir, "index.js"),
        "console.log('STRIP_OK ' + process.version);",
      );
      stampTree(fixtureDir);
      // The level only speeds the build up; stripping does not depend on it.
      const build = (name, extraArgs = []) => {
        const outputBin = path.resolve(name);
        const metadata = path.resolve(`${name}.json`);
        outputs.push(outputBin, metadata);
        execFileSync(
          process.execPath,
          [
            "build/index.mjs",
            "-i",
            fixtureDir,
            "-o",
            outputBin,
            "--metadata-file",
            path.basename(metadata),
            ...extraArgs,
            "--",
            "{{caxa}}/node_modules/.bin/node",
            "{{caxa}}/index.js",
          ],
          {
            stdio: "ignore",
            env: { ...process.env, CAXA_ZSTD_LEVEL: "1" },
          },
        );
        const node = JSON.parse(fs.readFileSync(metadata, "utf8")).components.find(
          (component) => component.name === "node",
        );
        return { outputBin, node };
      };
      // Runs the binary on a fresh cache and returns its extracted Node.
      const extractedNode = (outputBin) => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-strip-"));
        outputs.push(cacheDir);
        const stdout = execFileSync(outputBin, [], {
          encoding: "utf8",
          env: lazyEnv(cacheDir),
        });
        assert.equal(stdout.trim(), `STRIP_OK ${process.version}`);
        const id = fs.readdirSync(path.join(cacheDir, "apps"))[0];
        return path.join(cacheDir, "apps", id, "0", "node_modules/.bin/node-real");
      };
      const strippedProperty = (node) =>
        node.properties.find((p) => p.name === "cdx:caxa:stripped")?.value;

      const stripped = build("test-output-strip");
      const node = extractedNode(stripped.outputBin);
      assert.ok(
        fs.statSync(node).size < fs.statSync(nodePath).size,
        `the extracted Node (${fs.statSync(node).size} bytes) must be smaller than ${nodePath} (${fs.statSync(nodePath).size} bytes)`,
      );
      assert.equal(strippedProperty(stripped.node), "true");
      // The ~100 MB Node binary is long enough to be split into parts.
      const { footer } = v2Payload(stripped.outputBin);
      assert.ok(
        footer.aligned.some((entry) => entry.parts?.length > 1),
        JSON.stringify(footer.aligned),
      );
      // The same input gives the same bytes: strip and an ad-hoc signature
      // are deterministic, as the content-addressed identifier requires.
      assert.equal(
        sha256File(build("test-output-strip-again").outputBin),
        sha256File(stripped.outputBin),
      );
      if (process.platform === "darwin") {
        // Signed ad hoc, with the original's identifier, entitlements and
        // hardened runtime flag.
        execFileSync("codesign", ["--verify", "--strict", node]);
        const details = (file) => {
          const { stderr } = spawnSync("codesign", ["-dv", file], {
            encoding: "utf8",
          });
          const flags = stderr.match(/^CodeDirectory .*flags=\S+/m)?.[0] ?? "";
          return {
            identifier: stderr.match(/^Identifier=(.+)$/m)?.[1],
            runtime: /\bruntime\b/.test(flags),
            entitlements: spawnSync(
              "codesign",
              ["-d", "--entitlements", "-", "--xml", file],
              { encoding: "utf8" },
            ).stdout,
          };
        };
        assert.deepStrictEqual(details(node), details(nodePath));
        assert.match(
          spawnSync("codesign", ["-dv", node], { encoding: "utf8" }).stderr,
          /Signature=adhoc/,
        );
      }

      const kept = build("test-output-strip-kept", ["--no-strip-node"]);
      assert.ok(
        fs.readFileSync(extractedNode(kept.outputBin)).equals(
          fs.readFileSync(nodePath),
        ),
        "--no-strip-node bundles Node byte for byte",
      );
      assert.equal(strippedProperty(kept.node), undefined);
    } finally {
      cleanup(fixtureDir, ...outputs);
    }
  },
);

test("caxa zstd frames: payload bytes identical across repeat builds and worker counts", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-frames");
  const binExt = process.platform === "win32" ? ".exe" : "";
  const outputs = [
    { workers: "1", name: "test-output-frames-w1" },
    { workers: "2", name: "test-output-frames-w2" },
    {
      workers: String(os.availableParallelism()),
      name: "test-output-frames-wmax",
    },
    { workers: undefined, name: "test-output-frames-default" },
  ];
  const binaries = outputs.map(({ name }) => path.resolve(name + binExt));

  for (const candidate of [fixtureDir, ...binaries]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(path.join(fixtureDir, "sub"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "frames-app", version: "1.0.0" }),
  );
  // The app counts its extracted data files, so an entry lost or renamed
  // across a frame boundary fails the run instead of passing silently.
  fs.writeFileSync(
    path.join(fixtureDir, "index.js"),
    "const n = require('fs').readdirSync(require('path').join(__dirname, 'sub')).filter((f) => f.endsWith('.bin')).length; console.log(n === 12 ? 'FRAMES_OK' : 'FRAMES_MISSING ' + n);",
  );
  // Names over 100 bytes need pax long-name records in the tar, which a frame
  // cut must never separate from the entry they describe.
  const dataName = (i) => `${"long-name-".repeat(11)}data-${i}.bin`;
  // Incompressible filler so the 64 KiB frames below span several frames and
  // actually exercise multi-frame decoding.
  let seed = 0x12345678;
  const filler = Buffer.alloc(24 * 1024);
  for (let i = 0; i < filler.length; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    filler[i] = seed >>> 24;
  }
  for (let i = 0; i < 12; i += 1) {
    fs.writeFileSync(path.join(fixtureDir, "sub", dataName(i)), filler);
  }
  // Symlinks used to be stamped with the build time, breaking determinism.
  if (process.platform !== "win32") {
    fs.symlinkSync(dataName(0), path.join(fixtureDir, "sub", "data-link"));
  }

  // Fixed mtimes keep the tar headers identical across builds.
  const epoch = new Date(0);
  fs.utimesSync(fixtureDir, epoch, epoch);
  fs.utimesSync(path.join(fixtureDir, "sub"), epoch, epoch);
  for (const name of ["package.json", "index.js"]) {
    fs.utimesSync(path.join(fixtureDir, name), epoch, epoch);
  }
  for (let i = 0; i < 12; i += 1) {
    fs.utimesSync(path.join(fixtureDir, "sub", dataName(i)), epoch, epoch);
  }
  if (process.platform !== "win32") {
    fs.lutimesSync(path.join(fixtureDir, "sub", "data-link"), epoch, epoch);
  }

  const hashes = new Map();
  try {
    for (const { workers, name } of outputs) {
      const env = { ...process.env, CAXA_ZSTD_FRAME: String(64 * 1024) };
      if (workers !== undefined) {
        env.CAXA_ZSTD_WORKERS = workers;
      }
      const outputBin = path.resolve(name + binExt);
      execFileSync(
        process.execPath,
        [
          "build/index.mjs",
          "-i",
          fixtureDir,
          "-o",
          outputBin,
          "--no-include-node",
          "--",
          process.execPath,
          "{{caxa}}/index.js",
        ],
        { stdio: "inherit", env },
      );
      hashes.set(
        name,
        createHash("sha256").update(fs.readFileSync(outputBin)).digest("hex"),
      );
    }

    // The cache identifier is a hash of the payload bytes, so every build must
    // produce the exact same binary regardless of worker count.
    assert.equal(
      new Set(hashes.values()).size,
      1,
      `payload bytes differ between builds with different worker counts: ${[...hashes].map(([n, h]) => `${n}=${h.slice(0, 12)}`).join(" ")}`,
    );

    // The stub decodes the concatenated frames transparently.
    assert.match(
      execFileSync(binaries[0], [], { encoding: "utf8" }),
      /FRAMES_OK/,
    );

    // CAXA_ZSTD_WORKERS=0 is the single-stream payload; it must still decode.
    const singleStreamBin = path.resolve("test-output-frames-stream" + binExt);
    if (fs.existsSync(singleStreamBin)) fs.unlinkSync(singleStreamBin);
    try {
      execFileSync(
        process.execPath,
        [
          "build/index.mjs",
          "-i",
          fixtureDir,
          "-o",
          singleStreamBin,
          "--no-include-node",
          "--",
          process.execPath,
          "{{caxa}}/index.js",
        ],
        { stdio: "inherit", env: { ...process.env, CAXA_ZSTD_WORKERS: "0" } },
      );
      assert.match(
        execFileSync(singleStreamBin, [], { encoding: "utf8" }),
        /FRAMES_OK/,
      );
    } finally {
      cleanup(singleStreamBin);
    }
  } finally {
    cleanup(fixtureDir, ...binaries);
  }
});

test("caxa payload format: native builds default to v2 frames; --payload-format v1 stays single stream", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-payload-format");
  const binExt = process.platform === "win32" ? ".exe" : "";
  const defaultBin = path.resolve("test-output-format-v2" + binExt);
  const v1Bin = path.resolve("test-output-format-v1" + binExt);

  for (const candidate of [fixtureDir, defaultBin, v1Bin]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "format-app", version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "index.js"),
    "console.log('FORMAT_OK');",
  );

  try {
    for (const [outputBin, extraArgs] of [
      [defaultBin, []],
      [v1Bin, ["--payload-format", "v1"]],
    ]) {
      execFileSync(
        process.execPath,
        [
          "build/index.mjs",
          "-i",
          fixtureDir,
          "-o",
          outputBin,
          "--no-include-node",
          ...extraArgs,
          "--",
          process.execPath,
          "{{caxa}}/index.js",
        ],
        { stdio: "inherit" },
      );
    }

    // Documented trailer layout: the format magic is the first field of the
    // trailer, 48 bytes (v2) or 32 bytes (v1) from the end of the file.
    const v2Bytes = fs.readFileSync(defaultBin);
    assert.equal(
      v2Bytes
        .subarray(v2Bytes.length - 48, v2Bytes.length - 40)
        .toString("latin1"),
      "CAXAIDX2",
      "default native builds must use the v2 payload format",
    );
    const v1Bytes = fs.readFileSync(v1Bin);
    assert.equal(
      v1Bytes
        .subarray(v1Bytes.length - 32, v1Bytes.length - 24)
        .toString("latin1"),
      "CAXAIDX1",
      "--payload-format v1 must use the single-stream format",
    );

    assert.match(
      execFileSync(defaultBin, [], { encoding: "utf8" }),
      /FORMAT_OK/,
    );
    assert.match(execFileSync(v1Bin, [], { encoding: "utf8" }), /FORMAT_OK/);
  } finally {
    cleanup(fixtureDir, defaultBin, v1Bin);
  }
});

test("caxa batch mode: multiple native outputs share one payload build", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-batch");
  const outputOne = path.resolve(
    "test-output-batch-one" + (process.platform === "win32" ? ".exe" : ""),
  );
  const outputTwo = path.resolve(
    "test-output-batch-two" + (process.platform === "win32" ? ".exe" : ""),
  );
  const targetsFile = path.resolve("test/e2e-targets.json");
  const metadataOne = path.resolve("batch-one-metadata.json");
  const metadataTwo = path.resolve("batch-two-metadata.json");
  const sharedTempDir = path.resolve("test-output-batch-cache");

  for (const candidate of [
    fixtureDir,
    outputOne,
    outputTwo,
    targetsFile,
    metadataOne,
    metadataTwo,
    sharedTempDir,
  ]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({
      name: "batch-app",
      version: "1.0.0",
    }),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "entry-one.js"),
    "console.log('BATCH_ONE_OK');",
  );
  fs.writeFileSync(
    path.join(fixtureDir, "entry-two.js"),
    "console.log('BATCH_TWO_OK');",
  );
  fs.writeFileSync(
    targetsFile,
    JSON.stringify([
      {
        output: outputOne,
        metadataFile: path.basename(metadataOne),
        command: [process.execPath, "{{caxa}}/entry-one.js"],
      },
      {
        output: outputTwo,
        metadataFile: path.basename(metadataTwo),
        command: [process.execPath, "{{caxa}}/entry-two.js"],
      },
    ]),
  );

  execFileSync(
    process.execPath,
    [
      "build/index.mjs",
      "-i",
      fixtureDir,
      "--no-include-node",
      "--targets-file",
      targetsFile,
    ],
    { stdio: "inherit" },
  );

  assert.ok(fs.existsSync(outputOne), "First batch output should exist");
  assert.ok(fs.existsSync(outputTwo), "Second batch output should exist");
  assert.ok(fs.existsSync(metadataOne), "First metadata file should exist");
  assert.ok(fs.existsSync(metadataTwo), "Second metadata file should exist");

  assert.match(
    execFileSync(outputOne, [], {
      encoding: "utf8",
      env: { ...process.env, CAXA_TEMP_DIR: sharedTempDir },
    }),
    /BATCH_ONE_OK/,
  );
  assert.match(
    execFileSync(outputTwo, [], {
      encoding: "utf8",
      env: { ...process.env, CAXA_TEMP_DIR: sharedTempDir },
    }),
    /BATCH_TWO_OK/,
  );

  const appCacheRoot = path.join(sharedTempDir, "apps");
  const cacheEntries = fs.existsSync(appCacheRoot)
    ? fs
        .readdirSync(appCacheRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  assert.equal(
    cacheEntries.length,
    1,
    "Binaries built from the same payload should share one extracted cache directory",
  );

  cleanup(
    fixtureDir,
    outputOne,
    outputTwo,
    targetsFile,
    metadataOne,
    metadataTwo,
    sharedTempDir,
  );
});

test("caxa batch mode: --no-force is honored for targets without an explicit force override", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-batch-no-force");
  const outputBin = path.resolve(
    "test-output-batch-no-force" + (process.platform === "win32" ? ".exe" : ""),
  );
  const targetsFile = path.resolve("test/e2e-targets-no-force.json");

  for (const candidate of [fixtureDir, outputBin, targetsFile]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "batch-no-force-app", version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "index.js"),
    "console.log('BATCH_NO_FORCE_OK');",
  );
  fs.writeFileSync(outputBin, "existing output should not be overwritten");
  fs.writeFileSync(
    targetsFile,
    JSON.stringify([
      {
        output: outputBin,
        command: [process.execPath, "{{caxa}}/index.js"],
      },
    ]),
  );

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          "build/index.mjs",
          "-i",
          fixtureDir,
          "--no-include-node",
          "--no-force",
          "--targets-file",
          targetsFile,
        ],
        { encoding: "utf8" },
      ),
    (error) => {
      assert.equal(error.status, 1);
      assert.match(`${error.stdout}\n${error.stderr}`, /Output already exists/);
      return true;
    },
  );

  assert.equal(
    fs.readFileSync(outputBin, "utf8"),
    "existing output should not be overwritten",
  );

  for (const candidate of [fixtureDir, outputBin, targetsFile]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
});

test("caxa cli: variadic --upx-args values are forwarded to the UPX process", async () => {
  const fixtureDir = path.resolve("test/e2e-fixture-upx-args");
  const outputBin = path.resolve(
    "test-output-upx-args" + (process.platform === "win32" ? ".exe" : ""),
  );
  const fakeBinDir = path.resolve("test/e2e-fake-upx-bin");
  const fakeUpxHandler = path.join(fakeBinDir, "upx-handler.js");
  const fakeUpxExecutable = path.join(
    fakeBinDir,
    process.platform === "win32" ? "upx.cmd" : "upx",
  );
  const upxLogPath = path.resolve("test/e2e-fake-upx-log.json");

  for (const candidate of [
    fixtureDir,
    outputBin,
    fakeBinDir,
    upxLogPath,
    path.resolve("binary-metadata.json"),
  ]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }

  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "upx-args-app", version: "1.0.0" }),
  );
  fs.writeFileSync(
    path.join(fixtureDir, "index.js"),
    "console.log('UPX_ARGS_OK');",
  );
  fs.writeFileSync(
    fakeUpxHandler,
    [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.UPX_LOG, JSON.stringify(process.argv.slice(2)));",
    ].join("\n"),
  );
  fs.writeFileSync(
    fakeUpxExecutable,
    process.platform === "win32"
      ? [
          "@echo off",
          `\"${process.execPath.replace(/\//g, "\\")}\" \"${fakeUpxHandler.replace(/\//g, "\\")}\" %*`,
        ].join("\r\n")
      : [
          "#!/bin/sh",
          `exec \"${process.execPath}\" \"${fakeUpxHandler}\" \"$@\"`,
        ].join("\n"),
  );
  if (process.platform !== "win32") {
    fs.chmodSync(fakeUpxExecutable, 0o755);
  }

  execFileSync(
    process.execPath,
    [
      "build/index.mjs",
      "-i",
      fixtureDir,
      "-o",
      outputBin,
      "--no-include-node",
      "--upx",
      "--upx-args",
      "--best",
      "--lzma",
      "--",
      process.execPath,
      "{{caxa}}/index.js",
    ],
    {
      encoding: "utf8",
      env: withPrefixedPath(fakeBinDir, {
        UPX_LOG: upxLogPath,
      }),
    },
  );

  assert.ok(
    fs.existsSync(upxLogPath),
    "Expected the fake UPX executable to be invoked and write its argument log",
  );
  const forwardedUpxArgs = JSON.parse(fs.readFileSync(upxLogPath, "utf8"));
  assert.deepEqual(forwardedUpxArgs.slice(0, 2), ["--best", "--lzma"]);
  assert.equal(
    forwardedUpxArgs.at(-1).replace(/\\/g, "/"),
    outputBin.replace(/\\/g, "/"),
  );
  assert.match(
    execFileSync(outputBin, [], { encoding: "utf8" }),
    /UPX_ARGS_OK/,
  );

  cleanup(fixtureDir, outputBin, fakeBinDir, upxLogPath);
});

test("caxa sbom metadata: every emitted purl satisfies the Package URL spec", async () => {
  const { getParentComponent, getRuntimeInformation } =
    await import("../build/index.mjs");
  const { Purl } = await import("@cdxgen/cdx-purl");

  const invalid = [];
  let checked = 0;
  const walk = (component, where) => {
    if (!component || typeof component !== "object") {
      return;
    }
    if (typeof component.purl === "string") {
      checked++;
      try {
        Purl.parse(component.purl);
      } catch (error) {
        invalid.push(`${where}: ${component.purl} (${error.code})`);
      }
    }
    for (const [index, child] of (component.components ?? []).entries()) {
      walk(child, `${where}.components[${index}]`);
    }
  };

  const parentComponent = getParentComponent(process.cwd(), "/tmp/caxa-test");
  walk(parentComponent, "parentComponent");
  const runtimeInformation = getRuntimeInformation();
  walk(runtimeInformation, "runtimeInformation");

  assert.ok(checked > 0, "expected at least one purl to validate");
  assert.deepStrictEqual(invalid, [], `invalid purls emitted: ${invalid}`);

  // arch/platform are not valid qualifiers for the generic purl type, so they
  // must travel as properties instead.
  assert.ok(
    !parentComponent.purl.includes("arch="),
    "parent purl must not carry an arch qualifier",
  );
  const propertyNames = (parentComponent.properties ?? []).map((p) => p.name);
  assert.ok(propertyNames.includes("cdx:caxa:arch"));
  assert.ok(propertyNames.includes("cdx:caxa:platform"));

  // bom-refs key the dependency graph, so they must be unique.
  const refs = (runtimeInformation.components ?? []).map((c) => c["bom-ref"]);
  assert.strictEqual(
    new Set(refs).size,
    refs.length,
    "duplicate bom-refs in runtime components",
  );
});

// --- lazy members ---

// The commit the lazy-member work branched from, before lazy members. Its
// packager and stub are the compatibility references: a --lazy or --lazy-auto
// binary must run on its stub (which ignores the lazy footer field and
// extracts everything), and builds without lazy options must match its
// payload bytes.
const MAIN_REF = process.env.CAXA_MAIN_REF ?? "cacb50f";
const mainRefDir = path.resolve("test/.main-ref");
const binExt = process.platform === "win32" ? ".exe" : "";
const hostStub = path.resolve(
  `stubs/stub--${process.platform}--${process.arch}`,
);

// Builds the reference packager and host stub once (cached in
// test/.main-ref, stamped with the commit it was built from, so a cache of
// another MAIN_REF is rebuilt instead of silently reused). Returns null when
// the commit is not in this clone, e.g. a shallow CI checkout.
function mainReference() {
  const cli = path.join(mainRefDir, "build", "index.mjs");
  const stub = path.join(mainRefDir, `stub${binExt}`);
  const stamp = path.join(mainRefDir, "commit");
  if (
    fs.existsSync(stamp) &&
    fs.readFileSync(stamp, "utf8").trim() === MAIN_REF
  ) {
    return { cli, stub };
  }
  const probe = spawnSync("git", ["cat-file", "-e", `${MAIN_REF}^{commit}`]);
  if (probe.status !== 0) {
    return null;
  }
  fs.rmSync(mainRefDir, { recursive: true, force: true });
  fs.mkdirSync(mainRefDir, { recursive: true });
  const archive = execFileSync("git", [
    "archive",
    MAIN_REF,
    "source",
    "stubs/Cargo.toml",
    "stubs/Cargo.lock",
    "stubs/src",
    "package.json",
    "tsconfig.json",
  ]);
  execFileSync("tar", ["-x", "-C", mainRefDir], { input: archive });
  fs.symlinkSync(
    path.resolve("node_modules"),
    path.join(mainRefDir, "node_modules"),
  );
  execFileSync(
    process.execPath,
    [path.resolve("node_modules/typescript/bin/tsc"), "-p", mainRefDir],
    {
      stdio: "inherit",
    },
  );
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(mainRefDir, "stubs/Cargo.toml"),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        CARGO_TARGET_DIR: path.join(mainRefDir, "target"),
      },
    },
  );
  fs.copyFileSync(
    path.join(mainRefDir, "target", "release", `caxa-stub${binExt}`),
    stub,
  );
  fs.writeFileSync(stamp, `${MAIN_REF}\n`);
  return { cli, stub };
}

const LAZY_TOOL = '#!/bin/sh\necho "LAZY_TOOL_OK $1"\n';

// The app reports the lazy member's state around spawning it, so each test can
// see the placeholder before first use and the real member after.
const LAZY_APP = `
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const tool = path.join(__dirname, "bin", "tool.sh");
const state = () => {
  const b = fs.readFileSync(tool);
  return { size: b.length, magic: b.subarray(b.length - 8).toString("latin1") };
};
const mode = process.argv[2];
if (mode === "path") {
  console.log(JSON.stringify({ tool, before: state() }));
} else if (mode === "parallel") {
  const one = () =>
    new Promise((resolve) =>
      execFile(tool, ["p"], { encoding: "utf8" }, (error, stdout, stderr) =>
        resolve(error ? "ERROR " + error.code + " " + stderr.trim() : stdout.trim()),
      ),
    );
  Promise.all(Array.from({ length: 8 }, one)).then((results) =>
    console.log(JSON.stringify({ results, after: state() })),
  );
} else {
  const before = state();
  const first = execFileSync(tool, ["one"], { encoding: "utf8" }).trim();
  const after = state();
  const second = execFileSync(tool, ["two"], { encoding: "utf8" }).trim();
  console.log(JSON.stringify({ before, first, after, second }));
}
`;

function writeLazyFixture(fixtureDir) {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "lazy-app", version: "1.0.0" }),
  );
  fs.writeFileSync(path.join(fixtureDir, "index.js"), LAZY_APP);
  fs.writeFileSync(path.join(fixtureDir, "bin", "tool.sh"), LAZY_TOOL, {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(fixtureDir, "bin", "notes.txt"), "not executable");
  // Exec bits on files that are read, not run: a checksum, and a shared
  // library with an ELF header. Neither may become a placeholder.
  fs.writeFileSync(
    path.join(fixtureDir, "bin", "tool.sha256"),
    `${"0".repeat(64)}  tool.sh\n`,
    { mode: 0o755 },
  );
  const elf = Buffer.alloc(64);
  elf.write("\x7fELF\x02\x01\x01", 0, "latin1");
  elf.writeUInt16LE(3, 16);
  fs.writeFileSync(path.join(fixtureDir, "bin", "libtool.so"), elf, {
    mode: 0o755,
  });
}

function buildLazy(
  fixtureDir,
  outputBin,
  extraArgs = [],
  env = process.env,
  command = [process.execPath, "{{caxa}}/index.js"],
) {
  if (fs.existsSync(outputBin)) fs.unlinkSync(outputBin);
  return execFileSync(
    process.execPath,
    [
      "build/index.mjs",
      "-i",
      fixtureDir,
      "-o",
      outputBin,
      "--no-include-node",
      ...extraArgs,
      "--",
      ...command,
    ],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  );
}

// Runs a binary with a private cache and no inherited CAXA_EXECUTABLE.
function lazyEnv(cacheDir, extra = {}) {
  const env = { ...process.env, CAXA_TEMP_DIR: cacheDir, ...extra };
  if (!("CAXA_EXECUTABLE" in extra)) delete env.CAXA_EXECUTABLE;
  return env;
}

function runJson(bin, args, env) {
  return JSON.parse(execFileSync(bin, args, { encoding: "utf8", env }).trim());
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function cleanup(...paths) {
  for (const candidate of paths) {
    // Windows can hold a just-run exe for a moment (EPERM), and rmSync does
    // not retry that for a file, whatever its maxRetries.
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.rmSync(candidate, { recursive: true, force: true });
        break;
      } catch (error) {
        if (
          process.platform !== "win32" ||
          !["EPERM", "EBUSY"].includes(error.code) ||
          attempt >= 50
        )
          throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  }
  if (fs.existsSync("binary-metadata.json"))
    fs.unlinkSync("binary-metadata.json");
}

const lazySkip =
  process.platform === "win32" ? "lazy members are a no-op on Windows" : false;

test(
  "caxa lazy: placeholder on cold start, materialized on first spawn",
  { skip: lazySkip },
  () => {
    const fixtureDir = path.resolve("test/e2e-fixture-lazy");
    const outputBin = path.resolve("test-output-lazy");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-lazy-"));
    try {
      writeLazyFixture(fixtureDir);
      const buildLog = buildLazy(fixtureDir, outputBin, ["--lazy", "bin/*"]);
      assert.match(buildLog, /lazy members \(1\):\n {2}bin\/tool\.sh/);
      const packedNormally = buildLog.split("packed normally")[1] ?? "";
      for (const name of ["notes.txt", "tool.sha256", "libtool.so"]) {
        assert.ok(
          packedNormally.includes(`\n  bin/${name}`),
          `bin/${name} must be packed normally:\n${buildLog}`,
        );
      }

      const stubSize = fs.statSync(hostStub).size;
      // Prefetch off: this test pins the on-demand path, which a background
      // prefetcher would race.
      const run = runJson(
        outputBin,
        [],
        lazyEnv(cacheDir, { CAXA_PREFETCH: "0" }),
      );
      // First run: the member is a placeholder, a stub copy with a small trailer.
      assert.equal(run.before.magic, "CAXALZY1");
      assert.ok(
        run.before.size > stubSize && run.before.size < stubSize + 4096,
        `placeholder is ${run.before.size} bytes, stub is ${stubSize}`,
      );
      assert.equal(run.first, "LAZY_TOOL_OK one");
      assert.equal(
        run.after.size,
        LAZY_TOOL.length,
        "the spawn must leave the real member in place",
      );
      assert.equal(run.second, "LAZY_TOOL_OK two");

      // Warm run: the real member runs directly.
      const warm = runJson(outputBin, [], lazyEnv(cacheDir));
      assert.equal(warm.before.size, LAZY_TOOL.length);
      assert.equal(warm.first, "LAZY_TOOL_OK one");
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

test(
  "caxa lazy: 8 parallel first spawns all succeed",
  { skip: lazySkip },
  () => {
    const fixtureDir = path.resolve("test/e2e-fixture-lazy-parallel");
    const outputBin = path.resolve("test-output-lazy-parallel");
    const cacheDirs = [];
    try {
      writeLazyFixture(fixtureDir);
      buildLazy(fixtureDir, outputBin, ["--lazy", "bin/tool.sh"]);
      // Several rounds, each on an empty cache, to give the race a chance.
      for (let round = 0; round < 5; round += 1) {
        const cacheDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "caxa-lazy-par-"),
        );
        cacheDirs.push(cacheDir);
        const { results, after } = runJson(
          outputBin,
          ["parallel"],
          lazyEnv(cacheDir, { CAXA_PREFETCH: "0" }),
        );
        assert.deepStrictEqual(results, Array(8).fill("LAZY_TOOL_OK p"));
        assert.equal(after.size, LAZY_TOOL.length);
        const binDir = fs.readdirSync(path.join(cacheDir, "apps"))[0];
        const leftovers = fs
          .readdirSync(path.join(cacheDir, "apps", binDir, "0", "bin"))
          .filter((name) => name.startsWith("."));
        assert.deepStrictEqual(
          leftovers,
          [],
          "temp files must not be left behind",
        );
      }
    } finally {
      cleanup(fixtureDir, outputBin, ...cacheDirs);
    }
  },
);

test(
  "caxa lazy: a moved binary fails clearly, then works when run again",
  { skip: lazySkip },
  () => {
    const fixtureDir = path.resolve("test/e2e-fixture-lazy-moved");
    const outputBin = path.resolve("test-output-lazy-moved");
    const movedBin = path.resolve("test-output-lazy-moved-away");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-lazy-moved-"));
    try {
      writeLazyFixture(fixtureDir);
      buildLazy(fixtureDir, outputBin, ["--lazy", "bin/tool.sh"]);
      // Prefetch off: the placeholder must still be there for the failure path.
      const { tool, before } = runJson(
        outputBin,
        ["path"],
        lazyEnv(cacheDir, { CAXA_PREFETCH: "0" }),
      );
      assert.equal(before.magic, "CAXALZY1");
      fs.renameSync(outputBin, movedBin);

      const failed = spawnSync(tool, ["x"], {
        encoding: "utf8",
        env: lazyEnv(cacheDir),
      });
      assert.notEqual(failed.status, 0);
      const lines = failed.stderr.trim().split("\n");
      assert.equal(lines.length, 1, `expected one line, got: ${failed.stderr}`);
      assert.match(
        lines[0],
        /^caxa: lazy member 'bin\/tool\.sh' of 'sha256-[0-9a-f]{32}' is unavailable: .*run the caxa binary again, or delete .*apps\/sha256-[0-9a-f]{32}$/,
      );
      assert.equal(
        fs.readFileSync(tool).subarray(-8).toString("latin1"),
        "CAXALZY1",
        "a failed run must leave the placeholder",
      );

      // A stale CAXA_EXECUTABLE pointing at a binary with another identifier is
      // not accepted either.
      const other = path.resolve("test-output-lazy-other");
      fs.writeFileSync(
        path.join(fixtureDir, "extra.txt"),
        "changes the identifier",
      );
      buildLazy(fixtureDir, other, ["--lazy", "bin/tool.sh"]);
      const stale = spawnSync(tool, ["x"], {
        encoding: "utf8",
        env: lazyEnv(cacheDir, { CAXA_EXECUTABLE: other }),
      });
      fs.unlinkSync(other);
      assert.notEqual(stale.status, 0);
      assert.match(stale.stderr, /identifier is 'sha256-/);

      const run = runJson(movedBin, [], lazyEnv(cacheDir));
      assert.equal(run.first, "LAZY_TOOL_OK one");
    } finally {
      cleanup(fixtureDir, outputBin, movedBin, cacheDir);
    }
  },
);

test(
  "caxa lazy: a --lazy binary runs on the stub from main, extracting everything",
  { skip: lazySkip },
  (t) => {
    const reference = mainReference();
    if (!reference) {
      t.skip(`reference commit ${MAIN_REF} is not in this clone`);
      return;
    }
    const fixtureDir = path.resolve("test/e2e-fixture-lazy-oldstub");
    const outputBin = path.resolve("test-output-lazy-oldstub");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-lazy-old-"));
    try {
      writeLazyFixture(fixtureDir);
      buildLazy(fixtureDir, outputBin, [
        "--lazy",
        "bin/tool.sh",
        "--stub",
        reference.stub,
      ]);
      const run = runJson(outputBin, [], lazyEnv(cacheDir));
      assert.equal(
        run.before.size,
        LAZY_TOOL.length,
        "the old stub must extract the lazy frame eagerly",
      );
      assert.notEqual(run.before.magic, "CAXALZY1");
      assert.equal(run.first, "LAZY_TOOL_OK one");
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

test(
  "caxa lazy: Windows extracts lazy members eagerly",
  { skip: process.platform === "win32" ? false : "Windows only" },
  () => {
    const fixtureDir = path.resolve("test/e2e-fixture-lazy-windows");
    const outputBin = path.resolve("test-output-lazy-windows.exe");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-lazy-win-"));
    try {
      writeLazyFixture(fixtureDir);
      // No exec bits on Windows: the #! header alone selects tool.sh, and the
      // checksum and shared library are still packed normally.
      const buildLog = buildLazy(fixtureDir, outputBin, ["--lazy", "bin/*"]);
      assert.match(buildLog, /lazy members \(1\):\n {2}bin\/tool\.sh\n/);
      const { before } = runJson(outputBin, ["path"], lazyEnv(cacheDir));
      assert.equal(
        before.size,
        LAZY_TOOL.length,
        "the lazy member must be extracted as the real file",
      );
      assert.notEqual(before.magic, "CAXALZY1");
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

test("caxa lazy: payload bytes are deterministic, and unchanged without --lazy", (t) => {
  const fixtureDir = path.resolve("test/e2e-fixture-lazy-determinism");
  const outputs = [];
  try {
    writeLazyFixture(fixtureDir);
    // Enough incompressible data for several 64 KiB hot frames, and a second
    // lazy member with a long name (pax/long-name record in its frame).
    let seed = 0x9e3779b9;
    const filler = Buffer.alloc(40 * 1024);
    for (let i = 0; i < filler.length; i += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      filler[i] = seed >>> 24;
    }
    for (let i = 0; i < 6; i += 1) {
      fs.writeFileSync(path.join(fixtureDir, `data-${i}.bin`), filler);
    }
    const longTool = path.join(
      fixtureDir,
      "bin",
      `${"long-name-".repeat(11)}tool.sh`,
    );
    fs.writeFileSync(
      longTool,
      Buffer.concat([Buffer.from(LAZY_TOOL), filler]),
      { mode: 0o755 },
    );
    const epoch = new Date(0);
    const stamp = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stamp(full);
        fs.utimesSync(full, epoch, epoch);
      }
    };
    stamp(fixtureDir);

    const build = (name, workers, extraArgs, cli = "build/index.mjs") => {
      const outputBin = path.resolve(name + binExt);
      outputs.push(outputBin);
      const env = { ...process.env, CAXA_ZSTD_FRAME: String(64 * 1024) };
      delete env.CAXA_LAZY;
      if (workers !== undefined) env.CAXA_ZSTD_WORKERS = workers;
      execFileSync(
        process.execPath,
        [
          cli,
          "-i",
          fixtureDir,
          "-o",
          outputBin,
          "--no-include-node",
          "--stub",
          hostStub,
          ...extraArgs,
          "--",
          process.execPath,
          "{{caxa}}/index.js",
        ],
        { stdio: "ignore", env },
      );
      return sha256File(outputBin);
    };

    const lazyArgs = ["--lazy", "bin/*.sh"];
    const lazyHashes = [
      build("test-output-lazy-w1", "1", lazyArgs),
      build("test-output-lazy-w2", "2", lazyArgs),
      build(
        "test-output-lazy-wmax",
        String(os.availableParallelism()),
        lazyArgs,
      ),
      build("test-output-lazy-default", undefined, lazyArgs),
      build("test-output-lazy-repeat", undefined, lazyArgs),
    ];
    assert.equal(
      new Set(lazyHashes).size,
      1,
      `--lazy payloads differ: ${lazyHashes.map((h) => h.slice(0, 12))}`,
    );

    // The same members selected through CAXA_LAZY give the same bytes.
    const viaEnv = path.resolve("test-output-lazy-env" + binExt);
    outputs.push(viaEnv);
    execFileSync(
      process.execPath,
      [
        "build/index.mjs",
        "-i",
        fixtureDir,
        "-o",
        viaEnv,
        "--no-include-node",
        "--stub",
        hostStub,
        "--",
        process.execPath,
        "{{caxa}}/index.js",
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          CAXA_ZSTD_FRAME: String(64 * 1024),
          CAXA_LAZY: "nothing/matches/*\nbin/*.sh",
        },
      },
    );
    assert.equal(sha256File(viaEnv), lazyHashes[0]);

    const plain = build("test-output-lazy-none", undefined, []);
    assert.notEqual(plain, lazyHashes[0]);
    const reference = mainReference();
    if (!reference) {
      t.diagnostic(
        `reference commit ${MAIN_REF} is not in this clone; main comparison skipped`,
      );
      return;
    }
    for (const workers of ["1", undefined]) {
      assert.equal(
        build(`test-output-lazy-none-${workers ?? "d"}`, workers, []),
        build(
          `test-output-lazy-main-${workers ?? "d"}`,
          workers,
          [],
          reference.cli,
        ),
        "builds without --lazy must be byte-identical to main",
      );
    }
  } finally {
    cleanup(fixtureDir, ...outputs);
  }
});

// A v2 binary's footer, and the compressed and decoded bytes of any of its
// frames.
function v2Payload(bin) {
  const bytes = fs.readFileSync(bin);
  const trailer = bytes.subarray(bytes.length - 48);
  assert.equal(trailer.subarray(0, 8).toString("latin1"), "CAXAIDX2");
  const [payloadOffset, , footerSize, indexOffset] = [8, 16, 24, 32].map((at) =>
    Number(trailer.readBigUInt64LE(at)),
  );
  const footer = JSON.parse(
    bytes
      .subarray(bytes.length - 48 - footerSize, bytes.length - 48)
      .toString("utf8"),
  );
  const entry = (i) =>
    [0, 8, 16].map((at) =>
      Number(bytes.readBigUInt64LE(indexOffset + i * 24 + at)),
    );
  const compressed = (i) => {
    const [offset, compressedSize] = entry(i);
    const start = payloadOffset + offset;
    return bytes.subarray(start, start + compressedSize);
  };
  const frame = (i) => {
    const decoded = zlib.zstdDecompressSync(compressed(i));
    assert.equal(decoded.length, entry(i)[2]);
    return decoded;
  };
  return { footer, frame, compressed };
}

// The footer's lazy members with their frames, decoded.
function lazyFrames(bin) {
  const { footer, frame } = v2Payload(bin);
  return footer.lazy.map((member) => ({
    member,
    decoded: frame(member.frame),
  }));
}

// Extracts one decoded single-entry frame with the system tar (bsdtar, GNU
// tar; two zero blocks end the archive), and lists the files it wrote.
function tarExtract(decoded, tarDir) {
  const tarFile = path.join(tarDir, "frame.tar");
  fs.writeFileSync(tarFile, Buffer.concat([decoded, Buffer.alloc(1024)]));
  const out = path.join(tarDir, "out");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out);
  execFileSync("tar", ["-xf", tarFile, "-C", out]);
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(out, full).split(path.sep).join("/"));
    }
  };
  walk(out);
  return { out, files };
}

test(
  "caxa lazy: frames are laid out for in-place decoding, and tar extracts them",
  { skip: lazySkip },
  () => {
    const fixtureDir = path.resolve("test/e2e-fixture-lazy-aligned");
    const outputBin = path.resolve("test-output-lazy-aligned");
    const tarDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-lazy-tar-"));
    try {
      writeLazyFixture(fixtureDir);
      // A long name adds a pax path record, which the alignment keeps.
      const longName = `bin/${"long-name-".repeat(11)}tool.sh`;
      const longTool = Buffer.concat([
        Buffer.from(LAZY_TOOL),
        noise(200 * 1024, 7),
      ]);
      fs.writeFileSync(path.join(fixtureDir, longName), longTool, {
        mode: 0o755,
      });
      buildLazy(fixtureDir, outputBin, ["--lazy", "bin/*.sh"]);
      const frames = lazyFrames(outputBin);
      assert.equal(frames.length, 2);
      for (const { member, decoded } of frames) {
        // The data ends the frame, after its padding, and starts on 64 KiB.
        const dataOffset = decoded.length - Math.ceil(member.size / 512) * 512;
        assert.equal(
          dataOffset % (64 * 1024),
          0,
          `${member.path}: data at ${dataOffset}`,
        );
        assert.deepStrictEqual(
          decoded.subarray(dataOffset, dataOffset + member.size),
          fs.readFileSync(path.join(fixtureDir, member.path)),
        );
        // The system tar extracts the frame as it is, pax comment and all.
        const { out, files } = tarExtract(decoded, tarDir);
        assert.deepStrictEqual(files, [member.path]);
        assert.deepStrictEqual(
          fs.readFileSync(path.join(out, member.path)),
          fs.readFileSync(path.join(fixtureDir, member.path)),
        );
      }
    } finally {
      cleanup(fixtureDir, outputBin, tarDir);
    }
  },
);

// --- in-place decode of large hot files ---

const HOT_APP = `
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");
const file = path.join(__dirname, "data", "big.bin");
const big = fs.readFileSync(file);
console.log(JSON.stringify({
  size: big.length,
  sha256: createHash("sha256").update(big).digest("hex"),
  mode: fs.statSync(file).mode & 0o777,
}));
`;

test("caxa hot: large files get aligned frames, extract in place, and stay readable", (t) => {
  const fixtureDir = path.resolve("test/e2e-fixture-hot-aligned");
  const tarDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-hot-tar-"));
  const outputs = [];
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(fixtureDir, "data"), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ name: "hot-aligned", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(fixtureDir, "index.js"), HOT_APP);
    // Past the 8 MiB floor and incompressible, between two small files.
    const big = noise(9 * 1024 * 1024, 11);
    fs.writeFileSync(path.join(fixtureDir, "data", "a.txt"), "a");
    fs.writeFileSync(path.join(fixtureDir, "data", "big.bin"), big, {
      mode: 0o750,
    });
    fs.writeFileSync(path.join(fixtureDir, "data", "z.txt"), "z");
    stampTree(fixtureDir);
    const sha256 = createHash("sha256").update(big).digest("hex");

    const build = (name, workers, stub = hostStub) => {
      const outputBin = path.resolve(name + binExt);
      outputs.push(outputBin);
      const env = { ...process.env };
      delete env.CAXA_LAZY;
      delete env.CAXA_LAZY_AUTO;
      delete env.CAXA_ZSTD_WORKERS;
      if (workers !== undefined) env.CAXA_ZSTD_WORKERS = workers;
      execFileSync(
        process.execPath,
        [
          "build/index.mjs",
          "-i",
          fixtureDir,
          "-o",
          outputBin,
          "--no-include-node",
          "--stub",
          stub,
          "--",
          process.execPath,
          "{{caxa}}/index.js",
        ],
        { stdio: "ignore", env },
      );
      return outputBin;
    };
    const outputBin = build("test-output-hot-aligned", undefined);
    const hashes = [
      outputBin,
      build("test-output-hot-aligned-w1", "1"),
      build("test-output-hot-aligned-wmax", String(os.availableParallelism())),
    ].map(sha256File);
    assert.equal(
      new Set(hashes).size,
      1,
      "payload bytes must not depend on the worker count",
    );

    // The footer lists the big file's frame: its data starts on 64 KiB, the
    // frame ends right after it, and tar extracts it as it is.
    const { footer, frame } = v2Payload(outputBin);
    assert.equal(footer.aligned?.length, 1, JSON.stringify(footer));
    const [aligned] = footer.aligned;
    assert.equal(aligned.size, big.length);
    const decoded = frame(aligned.frame);
    const dataOffset = decoded.length - Math.ceil(big.length / 512) * 512;
    assert.equal(dataOffset % (64 * 1024), 0, `data at ${dataOffset}`);
    assert.ok(
      decoded.subarray(dataOffset, dataOffset + big.length).equals(big),
    );
    const { out, files } = tarExtract(decoded, tarDir);
    assert.deepStrictEqual(files, ["data/big.bin"]);
    assert.ok(fs.readFileSync(path.join(out, "data/big.bin")).equals(big));

    // A cold start extracts it (in place on Unix), with its mode, and leaves
    // no temp file.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-hot-"));
    outputs.push(cacheDir);
    const run = runJson(outputBin, [], lazyEnv(cacheDir));
    assert.equal(run.size, big.length);
    assert.equal(run.sha256, sha256);
    if (process.platform !== "win32") assert.equal(run.mode, 0o750);
    const appDir = path.join(
      cacheDir,
      "apps",
      fs.readdirSync(path.join(cacheDir, "apps"))[0],
      "0",
    );
    const temps = fs
      .readdirSync(appDir)
      .filter((name) => name.includes(".caxa-"));
    assert.deepStrictEqual(temps, [], "no temp file may remain in the app dir");

    // The stub from main extracts the same layout with tar.
    const reference = mainReference();
    if (!reference) {
      t.diagnostic(
        `reference commit ${MAIN_REF} is not in this clone; main stub skipped`,
      );
      return;
    }
    const oldBin = build(
      "test-output-hot-aligned-oldstub",
      undefined,
      reference.stub,
    );
    const oldCache = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-hot-old-"));
    outputs.push(oldCache);
    assert.equal(runJson(oldBin, [], lazyEnv(oldCache)).sha256, sha256);
  } finally {
    cleanup(fixtureDir, tarDir, ...outputs);
  }
});

// --- split frames ---

// The app reports the hot file's and the lazy member's digests, and runs the
// member where lazy members are honoured, unless asked only to read.
const SPLIT_APP = `
const { createHash } = require("crypto");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const tool = path.join(__dirname, "bin", "tool.sh");
const before = fs.readFileSync(tool).subarray(-8).toString("latin1");
const run = process.platform !== "win32" && process.argv[2] !== "read";
const ran = run ? execFileSync(tool, ["split"], { encoding: "utf8" }).trim() : null;
console.log(JSON.stringify({ big: digest(path.join(__dirname, "data", "big.bin")), before, ran, tool: digest(tool) }));
`;

test("caxa split: long aligned frames are compressed in parts that decode alone, in parallel and on the stub from main", async (t) => {
  const fixtureDir = path.resolve("test/e2e-fixture-split");
  const outputs = [];
  try {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(fixtureDir, "data"), { recursive: true });
    fs.mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ name: "split-app", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(fixtureDir, "index.js"), SPLIT_APP);
    // A hot file past the 8 MiB floor and a 3 MiB lazy member, both several
    // 1 MiB parts long.
    const big = noise(9 * 1024 * 1024, 23);
    fs.writeFileSync(path.join(fixtureDir, "data", "big.bin"), big);
    // The shell stops at `exit`, before the noise.
    const tool = Buffer.concat([
      Buffer.from(`${LAZY_TOOL}exit 0\n`),
      noise(3 * 1024 * 1024, 29),
    ]);
    fs.writeFileSync(path.join(fixtureDir, "bin", "tool.sh"), tool, {
      mode: 0o755,
    });
    stampTree(fixtureDir);
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

    const build = (name, { workers, part, stub = hostStub } = {}) => {
      const outputBin = path.resolve(name + binExt);
      outputs.push(outputBin);
      const env = { ...process.env };
      for (const key of [
        "CAXA_LAZY",
        "CAXA_LAZY_AUTO",
        "CAXA_ZSTD_WORKERS",
        "CAXA_ZSTD_PART",
      ]) {
        delete env[key];
      }
      if (workers !== undefined) env.CAXA_ZSTD_WORKERS = workers;
      if (part !== undefined) env.CAXA_ZSTD_PART = part;
      buildLazy(
        fixtureDir,
        outputBin,
        ["--lazy", "bin/*.sh", "--stub", stub],
        env,
      );
      return outputBin;
    };
    const part = String(1024 * 1024);
    const outputBin = build("test-output-split", { part });
    const hashes = [
      outputBin,
      build("test-output-split-w1", { workers: "1", part }),
      build("test-output-split-wmax", {
        workers: String(os.availableParallelism()),
        part,
      }),
    ].map(sha256File);
    assert.equal(
      new Set(hashes).size,
      1,
      "payload bytes must not depend on the worker count",
    );

    // Both aligned frames are split, and every part is a zstd frame of its
    // own; together they are the frame a single decode gives.
    const { footer, frame, compressed } = v2Payload(outputBin);
    assert.equal(footer.aligned?.length, 1, JSON.stringify(footer.aligned));
    assert.equal(footer.lazy?.length, 1, JSON.stringify(footer.lazy));
    for (const entry of [footer.aligned[0], footer.lazy[0]]) {
      assert.ok(entry.parts?.length > 1, JSON.stringify(entry));
      const bytes = compressed(entry.frame);
      const whole = frame(entry.frame);
      let offset = 0;
      const decoded = entry.parts.map(([compressedSize, uncompressedSize]) => {
        const part = zlib.zstdDecompressSync(
          bytes.subarray(offset, offset + compressedSize),
        );
        offset += compressedSize;
        assert.equal(part.length, uncompressedSize);
        return part;
      });
      assert.equal(offset, bytes.length, "the parts cover the frame");
      assert.ok(Buffer.concat(decoded).equals(whole));
      // Every part but the last is a whole number of 64 KiB blocks.
      for (const [, uncompressedSize] of entry.parts.slice(0, -1)) {
        assert.equal(uncompressedSize % (64 * 1024), 0);
      }
    }
    assert.equal(footer.lazy[0].sha256, digest(compressed(footer.lazy[0].frame)));

    // At the default part size these files stay whole, and CAXA_ZSTD_PART=0
    // keeps every frame whole.
    for (const [name, value] of [
      ["test-output-split-default", undefined],
      ["test-output-split-off", "0"],
    ]) {
      const { footer: whole } = v2Payload(build(name, { part: value }));
      assert.equal(whole.aligned[0].parts, undefined);
      assert.equal(whole.lazy[0].parts, undefined);
    }

    // A cold start decodes the hot file in place and the member on its first
    // run, both on parallel threads.
    const expected = { big: digest(big), tool: digest(tool) };
    const cold = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-split-"));
    outputs.push(cold);
    const run = runJson(
      outputBin,
      [],
      lazyEnv(cold, { CAXA_PREFETCH: "0" }),
    );
    assert.equal(run.big, expected.big);
    assert.equal(run.tool, expected.tool);
    if (process.platform === "win32") {
      assert.notEqual(run.before, "CAXALZY1");
    } else {
      assert.equal(run.before, "CAXALZY1");
      assert.equal(run.ran, "LAZY_TOOL_OK split");
    }

    // The prefetcher streams the member's parts on one thread: the app only
    // reads the placeholder, so nothing else materializes it.
    if (process.platform !== "win32") {
      const warm = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-split-pf-"));
      outputs.push(warm);
      const read = runJson(
        outputBin,
        ["read"],
        lazyEnv(warm, { CAXA_PREFETCH: "1" }),
      );
      assert.equal(read.big, expected.big);
      const cache = prefetchCache(warm);
      await waitFor(() => fs.existsSync(cache.marker));
      await waitFor(() => !fs.existsSync(cache.lock));
      assert.equal(
        digest(fs.readFileSync(path.join(cache.appDir, "bin", "tool.sh"))),
        expected.tool,
      );
      assert.deepStrictEqual(cache.tempFiles(), []);
    }

    // The stub from main decodes the parts of each frame as one stream.
    const reference = mainReference();
    if (!reference) {
      t.diagnostic(
        `reference commit ${MAIN_REF} is not in this clone; main stub skipped`,
      );
      return;
    }
    const oldBin = build("test-output-split-oldstub", {
      part,
      stub: reference.stub,
    });
    const oldCache = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-split-old-"));
    outputs.push(oldCache);
    const old = runJson(oldBin, [], lazyEnv(oldCache));
    assert.equal(old.big, expected.big);
    assert.equal(old.tool, expected.tool);
    assert.notEqual(old.before, "CAXALZY1", "the old stub extracts it eagerly");
  } finally {
    cleanup(fixtureDir, ...outputs);
  }
});

test("caxa lazy: option validation", () => {
  const fixtureDir = path.resolve("test/e2e-fixture-lazy-options");
  const outputBin = path.resolve("test-output-lazy-options" + binExt);
  const fail = (args, env = process.env) => {
    try {
      buildLazy(fixtureDir, outputBin, args, env);
    } catch (error) {
      return String(error.stderr);
    }
    assert.fail(`build with ${args.join(" ")} should fail`);
  };
  try {
    writeLazyFixture(fixtureDir);
    assert.match(
      fail(["--lazy", "bin/*.txt"]),
      /--lazy pattern matches no executable: ‘bin\/\*\.txt’/,
    );
    assert.match(
      fail(["--lazy", "bin/tool.sh", "--payload-format", "v1"]),
      /--lazy requires the v2 payload format/,
    );
    assert.match(
      fail(["--lazy", "bin/tool.sh"], {
        ...process.env,
        CAXA_ZSTD_WORKERS: "0",
      }),
      /--lazy requires the v2 payload format/,
    );
    // --lazy-auto fails the same way on outputs that cannot carry lazy frames.
    assert.match(
      fail(["--lazy-auto", "--payload-format", "v1"]),
      /--lazy-auto requires the v2 payload format/,
    );
    assert.match(
      fail(["--lazy-auto"], { ...process.env, CAXA_ZSTD_WORKERS: "0" }),
      /--lazy-auto requires the v2 payload format/,
    );
    // CAXA_LAZY applies to every target, so a pattern without matches only
    // warns, and a v1 target ignores it.
    const env = { ...process.env, CAXA_LAZY: "plugins/missing/*" };
    const warned = spawnSync(
      process.execPath,
      [
        "build/index.mjs",
        "-i",
        fixtureDir,
        "-o",
        outputBin,
        "--no-include-node",
        "--",
        process.execPath,
        "{{caxa}}/index.js",
      ],
      { encoding: "utf8", env },
    );
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(
      warned.stderr,
      /CAXA_LAZY pattern ‘plugins\/missing\/\*’ matches no executable/,
    );
    const v1 = spawnSync(
      process.execPath,
      [
        "build/index.mjs",
        "-i",
        fixtureDir,
        "-o",
        outputBin,
        "--no-include-node",
        "--payload-format",
        "v1",
        "--",
        process.execPath,
        "{{caxa}}/index.js",
      ],
      { encoding: "utf8", env: { ...process.env, CAXA_LAZY: "bin/tool.sh" } },
    );
    assert.equal(v1.status, 0, v1.stderr);
    assert.match(v1.stderr, /CAXA_LAZY ignored/);
    // CAXA_LAZY_AUTO is reported and ignored the same way.
    const v1Auto = spawnSync(
      process.execPath,
      [
        "build/index.mjs",
        "-i",
        fixtureDir,
        "-o",
        outputBin,
        "--no-include-node",
        "--payload-format",
        "v1",
        "--",
        process.execPath,
        "{{caxa}}/index.js",
      ],
      { encoding: "utf8", env: { ...process.env, CAXA_LAZY_AUTO: "1" } },
    );
    assert.equal(v1Auto.status, 0, v1Auto.stderr);
    assert.match(v1Auto.stderr, /CAXA_LAZY_AUTO ignored/);
  } finally {
    cleanup(fixtureDir, outputBin);
  }
});

// --- lazy-auto ---

// Pseudo-random bytes, so zstd cannot shrink a fixture below the size a test
// relies on.
function noise(length, seed) {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    bytes[i] = seed >>> 24;
  }
  return bytes;
}

function stampTree(dir) {
  const epoch = new Date(0);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) stampTree(full);
    fs.utimesSync(full, epoch, epoch);
  }
}

// A real native executable for --lazy-auto to find: a caxa binary on the host
// stub whose app is `source`, padded with `pad` bytes of noise.
function nativeTool(outputBin, source, pad) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-native-"));
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "native-tool", version: "1.0.0" }),
    );
    fs.writeFileSync(path.join(dir, "index.js"), source);
    if (pad > 0) fs.writeFileSync(path.join(dir, "pad.bin"), noise(pad, pad));
    stampTree(dir);
    const env = { ...process.env };
    delete env.CAXA_LAZY;
    delete env.CAXA_LAZY_AUTO;
    execFileSync(
      process.execPath,
      [
        "build/index.mjs",
        "-i",
        dir,
        "-o",
        outputBin,
        "--no-include-node",
        "--stub",
        hostStub,
        "--",
        process.execPath,
        "{{caxa}}/index.js",
      ],
      { stdio: "ignore", env },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Reports every bin/ file's trailer magic, then runs the tools, unless
// "state" is passed (the Windows fixture has fake PE files).
const AUTO_APP = `
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const bin = (name) => path.join(__dirname, "bin", name);
const out = { magic: {} };
for (const name of fs.readdirSync(path.join(__dirname, "bin"))) {
  const b = fs.readFileSync(bin(name));
  out.magic[name] = b.subarray(b.length - 8).toString("latin1");
}
if (!process.argv.includes("state")) {
  for (const name of ["one", "two", "small"]) out[name] = execFileSync(bin(name), { encoding: "utf8" }).trim();
}
console.log(JSON.stringify(out));
`;

// One file per selection rule. Only bin/one and bin/two may be auto-selected.
function writeAutoFixture(fixtureDir) {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  const binDir = path.join(fixtureDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "lazy-auto-app", version: "1.0.0" }),
  );
  fs.writeFileSync(path.join(fixtureDir, "index.js"), AUTO_APP);
  // With the stub, 640 KiB of noise is past the 1 MiB floor on every host.
  const big = 640 * 1024;
  nativeTool(path.join(binDir, "one"), 'console.log("AUTO_ONE_OK")', big);
  nativeTool(path.join(binDir, "two"), 'console.log("AUTO_TWO_OK")', big);
  // The command's executable: it runs the outer app, which its own stub
  // exposes as CAXA_EXECUTABLE=<outer app>/bin/self.
  nativeTool(
    path.join(binDir, "self"),
    'const path = require("path");\nrequire(path.join(path.dirname(process.env.CAXA_EXECUTABLE), "..", "index.js"));',
    big,
  );
  // Native, but below the floor.
  nativeTool(path.join(binDir, "small"), 'console.log("AUTO_SMALL_OK")', 0);
  // Native and big, but named as a command argument, or as a shared library.
  for (const name of ["arg-tool", "libbig.so"]) {
    fs.copyFileSync(path.join(binDir, "one"), path.join(binDir, name));
    fs.chmodSync(path.join(binDir, name), 0o755);
  }
  // Big, with exec bits, not native executables: a #! script (interpreters
  // read those, so only an explicit --lazy glob selects them) and a checksum.
  fs.writeFileSync(
    path.join(binDir, "big.sh"),
    `#!/bin/sh\necho AUTO_SCRIPT_OK\n# ${"x".repeat(1024 * 1024)}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "big.sha256"),
    `${"0".repeat(64)}  big\n${"0".repeat(1024 * 1024)}\n`,
    { mode: 0o755 },
  );
  stampTree(fixtureDir);
}

test(
  "caxa lazy-auto: native executables of at least 1 MiB, never files the command names",
  { skip: lazySkip },
  () => {
    const fixtureDir = path.resolve("test/e2e-fixture-lazy-auto");
    const outputBin = path.resolve("test-output-lazy-auto");
    const viaEnvBin = path.resolve("test-output-lazy-auto-env");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-lazy-auto-"));
    try {
      writeAutoFixture(fixtureDir);
      const command = ["{{caxa}}/bin/self", "{{caxa}}/bin/arg-tool"];
      const env = { ...process.env, CAXA_LAZY: "" };
      delete env.CAXA_LAZY_AUTO;
      const buildLog = buildLazy(
        fixtureDir,
        outputBin,
        ["--lazy-auto"],
        env,
        command,
      );
      assert.match(
        buildLog,
        /lazy members \(2\):\n {2}bin\/one \(auto, \d+ bytes\)\n {2}bin\/two \(auto, \d+ bytes\)\n/,
      );

      // Prefetch off: the placeholders must survive until the spawns.
      const run = runJson(
        outputBin,
        [],
        lazyEnv(cacheDir, { CAXA_PREFETCH: "0" }),
      );
      assert.equal(run.magic.one, "CAXALZY1");
      assert.equal(run.magic.two, "CAXALZY1");
      for (const name of [
        "self",
        "arg-tool",
        "small",
        "libbig.so",
        "big.sh",
        "big.sha256",
      ]) {
        assert.notEqual(
          run.magic[name],
          "CAXALZY1",
          `bin/${name} must be extracted eagerly`,
        );
      }
      assert.equal(run.one, "AUTO_ONE_OK");
      assert.equal(run.two, "AUTO_TWO_OK");
      assert.equal(run.small, "AUTO_SMALL_OK");

      // CAXA_LAZY_AUTO=1 selects the same members, into the same bytes.
      buildLazy(
        fixtureDir,
        viaEnvBin,
        [],
        { ...env, CAXA_LAZY_AUTO: "1" },
        command,
      );
      assert.equal(sha256File(viaEnvBin), sha256File(outputBin));
    } finally {
      cleanup(fixtureDir, outputBin, viaEnvBin, cacheDir);
    }
  },
);

test(
  "caxa lazy-auto: deterministic, and compatible with the stub and packager from main",
  { skip: lazySkip },
  (t) => {
    const fixtureDir = path.resolve("test/e2e-fixture-lazy-auto-det");
    const outputs = [];
    try {
      writeAutoFixture(fixtureDir);
      const build = (
        name,
        workers,
        { cli = "build/index.mjs", stub = hostStub, auto = true } = {},
      ) => {
        const outputBin = path.resolve(name);
        outputs.push(outputBin);
        const env = { ...process.env, CAXA_ZSTD_FRAME: String(64 * 1024) };
        delete env.CAXA_LAZY;
        delete env.CAXA_LAZY_AUTO;
        delete env.CAXA_ZSTD_WORKERS;
        if (auto) env.CAXA_LAZY_AUTO = "1";
        if (workers !== undefined) env.CAXA_ZSTD_WORKERS = workers;
        execFileSync(
          process.execPath,
          [
            cli,
            "-i",
            fixtureDir,
            "-o",
            outputBin,
            "--no-include-node",
            "--stub",
            stub,
            "--",
            process.execPath,
            "{{caxa}}/index.js",
          ],
          { stdio: "ignore", env },
        );
        return outputBin;
      };
      const hashes = [
        build("test-output-lazy-auto-w1", "1"),
        build("test-output-lazy-auto-w2", "2"),
        build("test-output-lazy-auto-wmax", String(os.availableParallelism())),
        build("test-output-lazy-auto-default", undefined),
      ].map(sha256File);
      assert.equal(
        new Set(hashes).size,
        1,
        `--lazy-auto payloads differ: ${hashes.map((h) => h.slice(0, 12))}`,
      );

      const reference = mainReference();
      if (!reference) {
        t.diagnostic(
          `reference commit ${MAIN_REF} is not in this clone; main comparison skipped`,
        );
        return;
      }
      // The stub from main ignores the lazy footer field and extracts the auto
      // members eagerly.
      const oldCache = fs.mkdtempSync(
        path.join(os.tmpdir(), "caxa-lazy-auto-old-"),
      );
      outputs.push(oldCache);
      const old = runJson(
        build("test-output-lazy-auto-oldstub", undefined, {
          stub: reference.stub,
        }),
        [],
        lazyEnv(oldCache),
      );
      assert.notEqual(
        old.magic.one,
        "CAXALZY1",
        "the main stub must extract auto members eagerly",
      );
      assert.equal(old.one, "AUTO_ONE_OK");
      // A binary from main's packager runs on this stub.
      const mainCache = fs.mkdtempSync(
        path.join(os.tmpdir(), "caxa-lazy-auto-main-"),
      );
      outputs.push(mainCache);
      const main = runJson(
        build("test-output-lazy-auto-mainbin", undefined, {
          cli: reference.cli,
          auto: false,
        }),
        [],
        lazyEnv(mainCache),
      );
      assert.equal(main.one, "AUTO_ONE_OK");
    } finally {
      cleanup(fixtureDir, ...outputs);
    }
  },
);

test(
  "caxa lazy-auto: Windows selects native executables and extracts them eagerly",
  { skip: process.platform === "win32" ? false : "Windows only" },
  () => {
    const fixtureDir = path.resolve("test/e2e-fixture-lazy-auto-windows");
    const outputBin = path.resolve("test-output-lazy-auto-windows.exe");
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "caxa-lazy-auto-win-"),
    );
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      const binDir = path.join(fixtureDir, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(
        path.join(fixtureDir, "package.json"),
        JSON.stringify({ name: "lazy-auto-win", version: "1.0.0" }),
      );
      fs.writeFileSync(path.join(fixtureDir, "index.js"), AUTO_APP);
      // No exec bits on Windows: the headers alone decide. PE files only need
      // their MZ header here, since the app never runs them.
      const pe = (length, seed) =>
        Buffer.concat([Buffer.from("MZ"), noise(length, seed)]);
      const files = {
        "one.exe": pe(1024 * 1024, 1),
        "two.exe": pe(1024 * 1024, 2),
        "small.exe": pe(1024, 3),
        "libbig.dll": pe(1024 * 1024, 4),
        "big.sh": Buffer.from(`#!/bin/sh\n# ${"x".repeat(1024 * 1024)}\n`),
      };
      for (const [name, bytes] of Object.entries(files))
        fs.writeFileSync(path.join(binDir, name), bytes);
      const buildLog = buildLazy(fixtureDir, outputBin, ["--lazy-auto"], {
        ...process.env,
        CAXA_LAZY: "",
      });
      assert.match(
        buildLog,
        /lazy members \(2\):\n {2}bin\/one\.exe \(auto, \d+ bytes\)\n {2}bin\/two\.exe \(auto, \d+ bytes\)\n/,
      );
      const run = runJson(outputBin, ["state"], lazyEnv(cacheDir));
      for (const [name, bytes] of Object.entries(files)) {
        assert.equal(
          run.magic[name],
          bytes.subarray(-8).toString("latin1"),
          `bin/${name} must be extracted eagerly`,
        );
      }
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

// --- background prefetch ---

// Polls until fn() returns a truthy value; no fixed sleeps.
async function waitFor(fn, timeoutMs = 60000, everyMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error("timed out waiting for a prefetch condition");
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

async function pidGone(pid, timeoutMs = 30000) {
  await waitFor(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }, timeoutMs);
}

// The app reports whether it sees the prefetch variable and the members'
// trailer magic, and can spawn a member while the prefetcher works.
const PREFETCH_MEMBERS = ["bin/tool-a.sh", "bin/tool-b.sh", "bin/tool-c.sh"];
const PREFETCH_APP = `
const { execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const members = ${JSON.stringify(PREFETCH_MEMBERS)};
const tool = (rel) => path.join(__dirname, rel);
const magicAll = () => Object.fromEntries(members.map((m) => [m, fs.readFileSync(tool(m)).subarray(-8).toString("latin1")]));
const out = { prefetchEnv: process.env.CAXA_PREFETCH_APP ?? "unset", magic: magicAll() };
const mode = process.argv[2];
if (mode === "parallel") {
  const one = () =>
    new Promise((resolve) =>
      execFile(tool("bin/tool-a.sh"), ["p"], { encoding: "utf8" }, (error, stdout, stderr) =>
        resolve(error ? "ERROR " + error.code + " " + stderr.trim() : stdout.trim()),
      ),
    );
  Promise.all(Array.from({ length: 8 }, one)).then((results) => {
    out.results = results;
    console.log(JSON.stringify(out));
  });
} else if (mode === "spawn") {
  out.spawn = execFileSync(tool("bin/tool-a.sh"), ["one"], { encoding: "utf8" }).trim();
  out.magicAfter = magicAll();
  console.log(JSON.stringify(out));
} else if (mode === "hold") {
  // Let go of the caller's extra pipe, then stay alive until stdin ends.
  fs.closeSync(3);
  process.stdin.resume();
  process.stdin.on("end", () => console.log(JSON.stringify(out)));
} else {
  console.log(JSON.stringify(out));
}
`;

// Three #! members (selected by an explicit --lazy glob), each padded with
// `fillerBytes` of noise so a prefetcher can be caught mid-run.
function writePrefetchFixture(fixtureDir, fillerBytes = 0) {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "prefetch-app", version: "1.0.0" }),
  );
  fs.writeFileSync(path.join(fixtureDir, "index.js"), PREFETCH_APP);
  const filler = noise(fillerBytes, 0x1f2e3d4c);
  for (const rel of PREFETCH_MEMBERS) {
    const label = path.basename(rel, ".sh").toUpperCase().replace("-", "_");
    const head = Buffer.from(
      `#!/bin/sh\necho "PREFETCH_${label}_OK $1"\nexit 0\n`,
    );
    fs.writeFileSync(
      path.join(fixtureDir, rel),
      Buffer.concat([head, filler]),
      { mode: 0o755 },
    );
  }
  stampTree(fixtureDir);
}

function buildPrefetch(fixtureDir, outputBin) {
  return buildLazy(fixtureDir, outputBin, ["--lazy", "bin/tool-*.sh"], {
    ...process.env,
    CAXA_LAZY: "",
  });
}

// One app dir of a cache: member paths, lock and marker locations.
function prefetchCache(cacheDir, attempt = "0") {
  const id = fs.readdirSync(path.join(cacheDir, "apps"))[0];
  const appDir = path.join(cacheDir, "apps", id, attempt);
  const lock = path.join(cacheDir, "locks", id, `${attempt}.prefetch`);
  const marker = path.join(appDir, ".caxa-prefetched");
  // Only the last 8 bytes: tests poll this on members of tens of MB.
  const readMagic = (rel) => {
    const fd = fs.openSync(path.join(appDir, rel), "r");
    try {
      const magic = Buffer.alloc(8);
      fs.readSync(fd, magic, 0, 8, fs.fstatSync(fd).size - 8);
      return magic.toString("latin1");
    } finally {
      fs.closeSync(fd);
    }
  };
  const tempFiles = () =>
    fs
      .readdirSync(path.join(appDir, "bin"))
      .filter((name) => name.startsWith("."));
  const lockPid = () => {
    const pid = fs.existsSync(lock) ? Number(fs.readFileSync(lock, "utf8")) : 0;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  };
  return { id, appDir, lock, marker, readMagic, tempFiles, lockPid };
}

// The marker is written after the last member and before the lock goes.
async function prefetchDone(cache) {
  await waitFor(() => fs.existsSync(cache.marker));
  await waitFor(() => !fs.existsSync(cache.lock));
  for (const rel of PREFETCH_MEMBERS) {
    assert.notEqual(
      cache.readMagic(rel),
      "CAXALZY1",
      `${rel} must be real after prefetch`,
    );
  }
  assert.deepStrictEqual(cache.tempFiles(), [], "no temp files may remain");
}

test(
  "caxa prefetch: a cold run returns, and the background prefetcher finishes the members",
  { skip: lazySkip },
  async () => {
    const fixtureDir = path.resolve("test/e2e-fixture-prefetch");
    const outputBin = path.resolve("test-output-prefetch");
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-prefetch-"));
    try {
      writePrefetchFixture(fixtureDir);
      assert.match(buildPrefetch(fixtureDir, outputBin), /lazy members \(3\)/);
      // The app never sees the prefetch variable. Whether it still sees
      // placeholders is the race the prefetcher is meant to win.
      const run = runJson(outputBin, [], lazyEnv(cacheDir));
      assert.equal(run.prefetchEnv, "unset");
      await prefetchDone(prefetchCache(cacheDir));
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

test(
  "caxa prefetch: 8 spawns during prefetch all succeed",
  { skip: lazySkip },
  async () => {
    const fixtureDir = path.resolve("test/e2e-fixture-prefetch-race");
    const outputBin = path.resolve("test-output-prefetch-race");
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "caxa-prefetch-race-"),
    );
    try {
      writePrefetchFixture(fixtureDir, 8 * 1024 * 1024);
      buildPrefetch(fixtureDir, outputBin);
      const { results } = runJson(outputBin, ["parallel"], lazyEnv(cacheDir));
      assert.deepStrictEqual(results, Array(8).fill("PREFETCH_TOOL_A_OK p"));
      await prefetchDone(prefetchCache(cacheDir));
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

test(
  "caxa prefetch: a killed prefetcher is replaced by the next start",
  { skip: lazySkip },
  async () => {
    const fixtureDir = path.resolve("test/e2e-fixture-prefetch-kill");
    const outputBin = path.resolve("test-output-prefetch-kill");
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "caxa-prefetch-kill-"),
    );
    try {
      writePrefetchFixture(fixtureDir, 24 * 1024 * 1024);
      buildPrefetch(fixtureDir, outputBin);
      runJson(outputBin, [], lazyEnv(cacheDir));
      const cache = prefetchCache(cacheDir);
      // Kill it once the first member is real and the marker is not there yet.
      const pid = await waitFor(
        () => {
          const pid = cache.lockPid();
          return pid &&
            !fs.existsSync(cache.marker) &&
            cache.readMagic(PREFETCH_MEMBERS[0]) !== "CAXALZY1"
            ? pid
            : null;
        },
        60000,
        2,
      );
      process.kill(pid, "SIGKILL");
      await pidGone(pid);
      assert.ok(
        !fs.existsSync(cache.marker),
        "a killed prefetcher must not leave the marker",
      );

      // The next start finds the placeholders, replaces the dead lock and
      // sweeps the killed prefetcher's temp file.
      const warm = runJson(outputBin, [], lazyEnv(cacheDir));
      assert.equal(warm.prefetchEnv, "unset");
      await prefetchDone(cache);
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

test(
  "caxa prefetch: a deleted cache ends the prefetcher and is not recreated",
  { skip: lazySkip },
  async () => {
    const fixtureDir = path.resolve("test/e2e-fixture-prefetch-gone");
    const outputBin = path.resolve("test-output-prefetch-gone");
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "caxa-prefetch-gone-"),
    );
    try {
      writePrefetchFixture(fixtureDir, 24 * 1024 * 1024);
      buildPrefetch(fixtureDir, outputBin);
      runJson(outputBin, [], lazyEnv(cacheDir));
      const pid = await waitFor(
        () => prefetchCache(cacheDir).lockPid(),
        60000,
        2,
      );
      fs.rmSync(cacheDir, { recursive: true, force: true });
      await pidGone(pid, 60000);
      assert.ok(
        !fs.existsSync(cacheDir),
        "the prefetcher must not recreate the deleted cache",
      );
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

test(
  "caxa prefetch: CAXA_PREFETCH=0 keeps the on-demand behaviour",
  { skip: lazySkip },
  async () => {
    const fixtureDir = path.resolve("test/e2e-fixture-prefetch-off");
    const outputBin = path.resolve("test-output-prefetch-off");
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "caxa-prefetch-off-"),
    );
    try {
      writePrefetchFixture(fixtureDir);
      buildPrefetch(fixtureDir, outputBin);
      const env = lazyEnv(cacheDir, { CAXA_PREFETCH: "0" });
      const run = runJson(outputBin, [], env);
      const cache = prefetchCache(cacheDir);
      // Give a wrongly spawned prefetcher every chance to show up.
      const appeared = await waitFor(
        () => fs.existsSync(cache.lock) || fs.existsSync(cache.marker),
        3000,
      ).then(
        () => true,
        () => false,
      );
      assert.equal(
        appeared,
        false,
        "no prefetcher may run with CAXA_PREFETCH=0",
      );
      for (const rel of PREFETCH_MEMBERS)
        assert.equal(
          run.magic[rel],
          "CAXALZY1",
          `${rel} must stay a placeholder`,
        );
      // On-demand materialization still works.
      const spawned = runJson(outputBin, ["spawn"], env);
      assert.equal(spawned.spawn, "PREFETCH_TOOL_A_OK one");
      assert.notEqual(spawned.magicAfter[PREFETCH_MEMBERS[0]], "CAXALZY1");
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

test(
  "caxa prefetch: two concurrent cold starts converge on real members",
  { skip: lazySkip },
  async () => {
    const fixtureDir = path.resolve("test/e2e-fixture-prefetch-double");
    const outputBin = path.resolve("test-output-prefetch-double");
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "caxa-prefetch-double-"),
    );
    try {
      writePrefetchFixture(fixtureDir, 4 * 1024 * 1024);
      buildPrefetch(fixtureDir, outputBin);
      const env = lazyEnv(cacheDir);
      const start = () =>
        new Promise((resolve, reject) =>
          execFile(outputBin, [], { encoding: "utf8", env }, (error, stdout) =>
            error ? reject(error) : resolve(JSON.parse(stdout.trim())),
          ),
        );
      for (const out of await Promise.all([start(), start()]))
        assert.equal(out.prefetchEnv, "unset");
      // The extraction protocol may give the second start its own attempt dir.
      const id = fs.readdirSync(path.join(cacheDir, "apps"))[0];
      for (const attempt of fs.readdirSync(path.join(cacheDir, "apps", id))) {
        await prefetchDone(prefetchCache(cacheDir, attempt));
      }
    } finally {
      cleanup(fixtureDir, outputBin, cacheDir);
    }
  },
);

test(
  "caxa prefetch: a caller waiting for EOF on an extra pipe is not held by the prefetcher",
  { skip: lazySkip },
  async () => {
    const fixtureDir = path.resolve("test/e2e-fixture-prefetch-fd");
    const outputBin = path.resolve("test-output-prefetch-fd");
    const cacheDirs = [];
    try {
      writePrefetchFixture(fixtureDir, 32 * 1024 * 1024);
      buildPrefetch(fixtureDir, outputBin);
      // The app closes its copy of fd 3 and stays alive; the prefetcher is then
      // stopped mid-run, so fd 3 can only reach EOF if the prefetcher does not
      // hold it. (The app must outlive the stop: a stopped member of an orphaned
      // process group gets SIGHUP.) A round where the prefetcher finishes
      // before it can be stopped proves nothing and is retried.
      for (let round = 0; round < 5; round += 1) {
        const cacheDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "caxa-prefetch-fd-"),
        );
        cacheDirs.push(cacheDir);
        const child = spawn(outputBin, ["hold"], {
          env: lazyEnv(cacheDir),
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        child.stdout.resume();
        child.stderr.resume();
        child.stdio[3].resume();
        const extraClosed = new Promise((resolve) =>
          child.stdio[3].on("close", resolve),
        );
        const exited = new Promise((resolve) => child.on("exit", resolve));
        let pid;
        let proven = false;
        try {
          pid = await waitFor(
            () =>
              fs.existsSync(path.join(cacheDir, "apps")) &&
              prefetchCache(cacheDir).lockPid(),
            60000,
            2,
          );
          const cache = prefetchCache(cacheDir);
          process.kill(pid, "SIGSTOP");
          if (fs.existsSync(cache.marker) || !fs.existsSync(cache.lock))
            continue;
          const timeout = new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(new Error("fd 3 stayed open while the prefetcher ran")),
              10000,
            ).unref(),
          );
          await Promise.race([extraClosed, timeout]);
          proven = true;
        } catch (error) {
          // ESRCH: gone before it could be stopped.
          if (error.code !== "ESRCH") throw error;
        } finally {
          try {
            if (pid) process.kill(pid, "SIGCONT");
          } catch {
            // Gone already.
          }
          child.stdin.end();
          await exited;
        }
        if (proven) {
          await prefetchDone(prefetchCache(cacheDir));
          return;
        }
      }
      assert.fail(
        "the prefetcher finished before it could be stopped in every round",
      );
    } finally {
      cleanup(fixtureDir, outputBin, ...cacheDirs);
    }
  },
);
