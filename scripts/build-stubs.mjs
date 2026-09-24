#!/usr/bin/env node

// Builds the Rust runtime stub (stubs/) for every supported target.
//
// Default: cross-compiles all targets from one host with cargo-zigbuild
// (requires rustup, zig and cargo-zigbuild on PATH).
// CAXA_STUBS=host: builds only the current platform with plain cargo. Used by
// the CI test matrix, where each runner only needs its own stub.

import { copyFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const workspaceRoot = path.resolve(import.meta.dirname, "..");
const stubsDirectory = path.join(workspaceRoot, "stubs");

// Linux targets use musl so the stub is fully static. Windows uses the LLVM
// mingw ABI, which zig can link for both x64 and arm64 without MSVC.
const buildMatrix = [
  { target: "x86_64-pc-windows-gnullvm", output: "stub--win32--x64" },
  { target: "aarch64-pc-windows-gnullvm", output: "stub--win32--arm64" },
  { target: "x86_64-apple-darwin", output: "stub--darwin--x64" },
  { target: "aarch64-apple-darwin", output: "stub--darwin--arm64" },
  { target: "x86_64-unknown-linux-musl", output: "stub--linux--x64" },
  { target: "aarch64-unknown-linux-musl", output: "stub--linux--arm64" },
  { target: "armv7-unknown-linux-musleabihf", output: "stub--linux--arm" },
];

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: stubsDirectory,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
    });
  });
}

function builtStub(target) {
  const name = target.includes("windows") ? "caxa-stub.exe" : "caxa-stub";
  return path.join(stubsDirectory, "target", target, "release", name);
}

async function removeExistingStubs() {
  const entries = await readdir(stubsDirectory);
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith("stub--"))
      .map((entry) => rm(path.join(stubsDirectory, entry), { force: true })),
  );
}

await removeExistingStubs();

if (process.env.CAXA_STUBS === "host") {
  await run("cargo", ["build", "--release", "--locked"]);
  const exe = process.platform === "win32" ? "caxa-stub.exe" : "caxa-stub";
  await copyFile(
    path.join(stubsDirectory, "target", "release", exe),
    path.join(stubsDirectory, `stub--${process.platform}--${process.arch}`),
  );
} else {
  await run("rustup", ["target", "add", ...buildMatrix.map((b) => b.target)]);
  for (const { target, output } of buildMatrix) {
    await run("cargo", ["zigbuild", "--release", "--locked", "--target", target]);
    await copyFile(builtStub(target), path.join(stubsDirectory, output));
  }
}
