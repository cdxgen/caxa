import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
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
