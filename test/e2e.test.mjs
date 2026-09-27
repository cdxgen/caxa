import { test } from "node:test";
import assert from "node:assert";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
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

  fs.rmSync(fixtureDir, { recursive: true, force: true });
  if (fs.existsSync(outputBin)) fs.unlinkSync(outputBin);
  if (fs.existsSync(metadataPath)) fs.unlinkSync(metadataPath);
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

  for (const candidate of [
    fixtureDir,
    outputBin,
    path.resolve("binary-metadata.json"),
  ]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
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

  for (const candidate of [fixtureDir, outputBin, metadataPath]) {
    if (fs.existsSync(candidate)) {
      fs.rmSync(candidate, { recursive: true, force: true });
    }
  }
});

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
      if (fs.existsSync(singleStreamBin)) fs.unlinkSync(singleStreamBin);
    }
  } finally {
    for (const candidate of [fixtureDir, ...binaries]) {
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    }
    if (fs.existsSync("binary-metadata.json"))
      fs.unlinkSync("binary-metadata.json");
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
    for (const candidate of [fixtureDir, defaultBin, v1Bin]) {
      if (fs.existsSync(candidate)) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    }
    if (fs.existsSync("binary-metadata.json"))
      fs.unlinkSync("binary-metadata.json");
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

// The commit the lazy-member work branched from, now main itself (the merge
// of #15). Its packager and stub are the compatibility references: a --lazy
// or --lazy-auto binary must run on its stub, and builds without the lazy
// options must match its payload bytes.
const MAIN_REF = process.env.CAXA_MAIN_REF ?? "6502616";
const mainRefDir = path.resolve("test/.main-ref");
const binExt = process.platform === "win32" ? ".exe" : "";
const hostStub = path.resolve(
  `stubs/stub--${process.platform}--${process.arch}`,
);

// Builds the reference packager and host stub once (cached in
// test/.main-ref). Returns null when the commit is not in this clone, e.g. a
// shallow CI checkout.
function mainReference() {
  const cli = path.join(mainRefDir, "build", "index.mjs");
  const stub = path.join(mainRefDir, `stub${binExt}`);
  if (fs.existsSync(cli) && fs.existsSync(stub)) {
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
    fs.rmSync(candidate, { recursive: true, force: true });
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
      const run = runJson(outputBin, [], lazyEnv(cacheDir));
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
          lazyEnv(cacheDir),
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
      const { tool, before } = runJson(outputBin, ["path"], lazyEnv(cacheDir));
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
    // --lazy-auto fails the same way on formats that cannot carry lazy frames.
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

// A fixture whose executables exercise every auto-selection rule: two big
// scripts are selected; the command's own executable, a small script, a
// shared library and a checksum with an exec bit are not. self.sh pads itself
// past 1 MiB so only the self-executable rule can keep it eager.
const AUTO_APP = `
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const state = (rel) => {
  const b = fs.readFileSync(path.join(__dirname, rel));
  return { size: b.length, magic: b.subarray(b.length - 8).toString("latin1") };
};
const result = {
  before: {
    one: state("bin/one.sh"),
    two: state("bin/two.sh"),
    self: state("bin/self.sh"),
  },
  one: execFileSync(path.join(__dirname, "bin/one.sh"), { encoding: "utf8" }).trim(),
  two: execFileSync(path.join(__dirname, "bin/two.sh"), { encoding: "utf8" }).trim(),
};
console.log(JSON.stringify(result));
`;

function writeAutoFixture(fixtureDir) {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(fixtureDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify({ name: "lazy-auto-app", version: "1.0.0" }),
  );
  fs.writeFileSync(path.join(fixtureDir, "index.js"), AUTO_APP);
  const pad = `# ${"x".repeat(1024 * 1024)}\n`;
  fs.writeFileSync(
    path.join(fixtureDir, "bin", "one.sh"),
    `#!/bin/sh\necho AUTO_ONE_OK\n${pad}`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fixtureDir, "bin", "two.sh"),
    `#!/bin/sh\necho AUTO_TWO_OK\n${pad}`,
    { mode: 0o755 },
  );
  // The command's own executable: big enough to qualify, but the command runs
  // it, so it must stay eager. It locates index.js itself: the stub only
  // substitutes {{caxa}} in the footer command, never inside packed files.
  fs.writeFileSync(
    path.join(fixtureDir, "bin", "self.sh"),
    `#!/bin/sh\nDIR=\$(CDPATH= cd -- "\$(dirname -- "$0")" && pwd)\nexec "${process.execPath}" "$DIR/../index.js" "$@"\n${pad}`,
    { mode: 0o755 },
  );
  // Smaller than the 1 MiB floor: never auto-selected.
  fs.writeFileSync(
    path.join(fixtureDir, "bin", "small.sh"),
    "#!/bin/sh\necho AUTO_SMALL_OK\n",
    { mode: 0o755 },
  );
  // Exec bits on files that are read, not run: a checksum and a shared
  // library, both over 1 MiB.
  fs.writeFileSync(
    path.join(fixtureDir, "bin", "big.sha256"),
    `${"0".repeat(64)} big\n${"0".repeat(1024 * 1024)}\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(fixtureDir, "bin", "libbig.dylib"),
    Buffer.alloc(1024 * 1024 + 16, 7),
    { mode: 0o755 },
  );
  const epoch = new Date(0);
  for (const entry of fs.readdirSync(fixtureDir, { withFileTypes: true })) {
    fs.utimesSync(path.join(fixtureDir, entry.name), epoch, epoch);
  }
  for (const name of [
    "one.sh",
    "two.sh",
    "self.sh",
    "small.sh",
    "big.sha256",
    "libbig.dylib",
  ]) {
    fs.utimesSync(path.join(fixtureDir, "bin", name), epoch, epoch);
  }
}

test("caxa lazy-auto: selects eligible executables, skips the command's own", () => {
  const fixtureDir = path.resolve("test/e2e-fixture-lazy-auto");
  const outputBin = path.resolve("test-output-lazy-auto");
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "caxa-lazy-auto-"));
  try {
    writeAutoFixture(fixtureDir);
    // The command runs the fixture's own big self.sh, which must stay eager
    // even though it passes every other auto rule.
    const selfCommand = ["{{caxa}}/bin/self.sh", "{{caxa}}/index.js"];
    const buildLog = buildLazy(
      fixtureDir,
      outputBin,
      ["--lazy-auto"],
      { ...process.env, CAXA_LAZY: "" },
      selfCommand,
    );
    assert.match(
      buildLog,
      /auto-lazy members \(2\):\n {2}bin\/one\.sh \(\d+ bytes\)\n {2}bin\/two\.sh \(\d+ bytes\)/,
    );
    for (const name of [
      "small.sh",
      "big.sha256",
      "libbig.dylib",
      "self.sh",
      "index.js",
      "package.json",
    ]) {
      assert.ok(
        !buildLog.includes(`\n  bin/${name}`) &&
          !new RegExp(`\n  ${name} \\(`).test(buildLog),
        `${name} must not be a lazy member:\n${buildLog}`,
      );
    }

    const run = runJson(outputBin, [], lazyEnv(cacheDir));
    // The selected members are placeholders until their first spawn; the
    // command's own executable was packed eagerly.
    assert.equal(run.before.one.magic, "CAXALZY1");
    assert.equal(run.before.two.magic, "CAXALZY1");
    assert.notEqual(run.before.self.magic, "CAXALZY1");
    assert.equal(run.one, "AUTO_ONE_OK");
    assert.equal(run.two, "AUTO_TWO_OK");

    // CAXA_LAZY_AUTO=1 selects the same members.
    const viaEnvBin = path.resolve("test-output-lazy-auto-env");
    const viaEnvLog = buildLazy(
      fixtureDir,
      viaEnvBin,
      [],
      {
        ...process.env,
        CAXA_LAZY: "",
        CAXA_LAZY_AUTO: "1",
      },
      selfCommand,
    );
    assert.match(viaEnvLog, /auto-lazy members \(2\):/);
    cleanup(viaEnvBin);
  } finally {
    cleanup(fixtureDir, outputBin, cacheDir);
  }
});

test("caxa lazy-auto: payload bytes are deterministic across repeats and worker counts", () => {
  const fixtureDir = path.resolve("test/e2e-fixture-lazy-auto-det");
  const outputs = [];
  try {
    writeAutoFixture(fixtureDir);
    const build = (name, workers, envExtra = {}) => {
      const outputBin = path.resolve(name + binExt);
      outputs.push(outputBin);
      const env = {
        ...process.env,
        CAXA_ZSTD_FRAME: String(64 * 1024),
        CAXA_LAZY: "",
        CAXA_LAZY_AUTO: "1",
        ...envExtra,
      };
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
          hostStub,
          "--",
          process.execPath,
          "{{caxa}}/index.js",
        ],
        { stdio: "ignore", env },
      );
      return sha256File(outputBin);
    };
    const hashes = [
      build("test-output-lazy-auto-w1", "1"),
      build("test-output-lazy-auto-w2", "2"),
      build("test-output-lazy-auto-wmax", String(os.availableParallelism())),
      build("test-output-lazy-auto-repeat", undefined),
    ];
    assert.equal(
      new Set(hashes).size,
      1,
      `--lazy-auto payloads differ: ${hashes.map((h) => h.slice(0, 12))}`,
    );

    // A --lazy-auto binary runs on the stub from main: the old stub ignores
    // nothing (the footer lazy array is the same shape) and extracts eagerly.
    const reference = mainReference();
    if (!reference) return;
    const oldStubBin = path.resolve("test-output-lazy-auto-oldstub" + binExt);
    outputs.push(oldStubBin);
    execFileSync(
      process.execPath,
      [
        "build/index.mjs",
        "-i",
        fixtureDir,
        "-o",
        oldStubBin,
        "--no-include-node",
        "--stub",
        reference.stub,
        "--",
        process.execPath,
        "{{caxa}}/index.js",
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          CAXA_ZSTD_FRAME: String(64 * 1024),
          CAXA_LAZY: "",
          CAXA_LAZY_AUTO: "1",
        },
      },
    );
    const cacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "caxa-lazy-auto-old-"),
    );
    outputs.push(cacheDir);
    const run = runJson(oldStubBin, [], lazyEnv(cacheDir));
    assert.equal(run.one, "AUTO_ONE_OK");
    assert.notEqual(
      run.before.one.magic,
      "CAXALZY1",
      "the main stub must extract the auto members eagerly",
    );

    // A binary built by the main packager still runs on this stub.
    const mainBin = path.resolve("test-output-lazy-auto-mainbin" + binExt);
    outputs.push(mainBin);
    execFileSync(
      process.execPath,
      [
        reference.cli,
        "-i",
        fixtureDir,
        "-o",
        mainBin,
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
          CAXA_LAZY: "",
        },
      },
    );
    const cacheDir2 = fs.mkdtempSync(
      path.join(os.tmpdir(), "caxa-lazy-auto-mainbin-"),
    );
    outputs.push(cacheDir2);
    assert.match(
      execFileSync(mainBin, [], { encoding: "utf8", env: lazyEnv(cacheDir2) }),
      /AUTO_ONE_OK/,
    );
  } finally {
    cleanup(fixtureDir, ...outputs);
  }
});
