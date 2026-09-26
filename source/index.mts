#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import * as fsp from "node:fs/promises";
import { arch, availableParallelism, platform } from "node:os";
import path from "node:path";
import type { Transform } from "node:stream";
import url from "node:url";
import stream from "node:stream/promises";
import { parseArgs } from "node:util";
import {
  constants as zlibConstants,
  createGzip,
  createZstdCompress,
} from "node:zlib";
import * as archiverModule from "archiver";
import process from "node:process";
import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { build } from "@cdxgen/cdx-purl";

const archiveSeparator = "\nCAXACAXACAXA\n";
const trailerMagic = "CAXAIDX1";
const trailerSize = 32;
const trailerMagic2 = "CAXAIDX2";
const trailer2Size = 48;
const indexEntrySize = 24;

// Payload formats: v1 is the single compressed stream of caxa <= 4.0; v2 cuts
// the tar into frames that end on entry boundaries, described by an index the
// runtime stub uses to decode and extract frames in parallel.
type PayloadFormat = "v1" | "v2";

// Payloads are write-once/read-many, so we favour aggressive compression at
// build time. Level 19 with long-distance matching yields substantially smaller
// payloads for node_modules trees (many near-duplicate files) with no cost to
// extraction speed. The environment variable escape hatch keeps builds tunable.
function zstdCompressOptions() {
  const level = Number.parseInt(process.env.CAXA_ZSTD_LEVEL ?? "", 10);
  return {
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]:
        Number.isFinite(level) && level > 0 ? level : 19,
      [zlibConstants.ZSTD_c_enableLongDistanceMatching]: 1,
    },
  };
}

// Node's bundled zstd accepts ZSTD_c_nbWorkers but does not compress on more
// than one core with it (measured on node v26.8.2: 4 workers buy ~8% wall time
// for 50% more CPU and an 18% larger payload; 14 workers are slower than one).
// Payloads are therefore cut into frames at tar entry boundaries and compressed
// on worker_threads. Frame boundaries follow the tar stream and the frame size
// alone — never worker scheduling — so payload bytes stay identical across
// repeat builds and worker counts, as the content-addressed identifier
// requires.
const DEFAULT_ZSTD_FRAME_BYTES = 8 * 1024 * 1024;
const MIN_ZSTD_FRAME_BYTES = 64 * 1024;
// Must match MAX_FRAME_UNCOMPRESSED in stubs/src/main.rs: the stub rejects
// larger frames, so building one would produce a binary that cannot start.
const MAX_ZSTD_FRAME_BYTES = 512 * 1024 * 1024;

function zstdFrameBytes(): number {
  const requested = Number.parseInt(process.env.CAXA_ZSTD_FRAME ?? "", 10);
  return Number.isFinite(requested) && requested >= MIN_ZSTD_FRAME_BYTES
    ? requested
    : DEFAULT_ZSTD_FRAME_BYTES;
}

// CAXA_ZSTD_WORKERS=0 disables framing and restores the single-stream payload.
function zstdWorkerCount(): number {
  const requested = Number.parseInt(process.env.CAXA_ZSTD_WORKERS ?? "", 10);
  return Number.isFinite(requested) && requested >= 0
    ? requested
    : availableParallelism();
}

interface FrameResult {
  seq: number;
  buf?: ArrayBuffer;
  error?: string;
}

interface FrameJob {
  seq: number;
  buffer: ArrayBuffer;
  resolve: (compressed: ArrayBuffer) => void;
  reject: (error: Error) => void;
}

// Fixed pool of workers; every job is one independent zstd frame.
function createZstdFramePool(workers: number, params: Record<number, number>) {
  const workerSource = `
    const { parentPort } = require("node:worker_threads");
    const { zstdCompressSync } = require("node:zlib");
    parentPort.on("message", ({ seq, buf, params }) => {
      try {
        const compressed = zstdCompressSync(Buffer.from(buf), { params });
        const out = compressed.buffer.slice(
          compressed.byteOffset,
          compressed.byteOffset + compressed.byteLength,
        );
        parentPort.postMessage({ seq, buf: out }, [out]);
      } catch (error) {
        parentPort.postMessage({ seq, error: error?.message ?? String(error) });
      }
    });
  `;
  const idle: Worker[] = [];
  const queue: FrameJob[] = [];
  const running = new Map<Worker, FrameJob>();
  let failure: Error | undefined;

  const dispatch = () => {
    while (queue.length > 0 && idle.length > 0) {
      const worker = idle.pop()!;
      const job = queue.shift()!;
      running.set(worker, job);
      worker.postMessage({ seq: job.seq, buf: job.buffer, params }, [
        job.buffer,
      ]);
    }
    if (failure) {
      for (const job of queue.splice(0)) {
        job.reject(failure);
      }
    }
  };

  const pool = Array.from({ length: workers }, () => {
    const worker = new Worker(workerSource, { eval: true });
    worker.on("message", ({ seq, buf, error }: FrameResult) => {
      const job = running.get(worker);
      running.delete(worker);
      idle.push(worker);
      if (job) {
        if (error || !buf) {
          job.reject(
            new Error(`zstd frame compression failed: ${error ?? "no output"}`),
          );
        } else {
          job.resolve(buf);
        }
      }
      dispatch();
    });
    worker.on("error", (error: Error) => {
      running.get(worker)?.reject(error);
      running.delete(worker);
      failure ??= error;
      dispatch();
    });
    idle.push(worker);
    return worker;
  });

  return {
    submit(seq: number, chunk: Buffer): Promise<ArrayBuffer> {
      if (failure) {
        return Promise.reject(failure);
      }
      // Stream chunks may be views into larger buffers; transfer an exact copy.
      const buffer = (chunk.buffer as ArrayBuffer).slice(
        chunk.byteOffset,
        chunk.byteOffset + chunk.byteLength,
      );
      return new Promise((resolve, reject) => {
        queue.push({ seq, buffer, resolve, reject });
        dispatch();
      });
    },
    async destroy(): Promise<void> {
      await Promise.allSettled(pool.map((worker) => worker.terminate()));
    },
  };
}

// Streams the archive once, cutting it into frames that are compressed
// concurrently and appended to `destination` in order. At most `workers`
// frames are in flight and the archive is paused while every worker is busy,
// so memory stays bounded by about (workers + 1) frames plus the largest tar
// entry. Frames end on the first tar entry boundary at or after `frameSize`,
// so the layout never depends on stream chunking or worker scheduling, and the
// returned index describes them for the v2 stub.
//
// Lazy members use `entryPerFrame`: every entry (with its pax/long-name
// records) becomes its own frame, the end-of-archive blocks are dropped, and
// the frames are appended after `offsetBase` bytes of payload already written.
async function compressStreamInFrames({
  archive,
  destination,
  params,
  frameSize,
  workers,
  entryPerFrame = false,
  offsetBase = 0,
  hashFrames = false,
}: {
  archive: ArchiveLike;
  destination: string;
  params: Record<number, number>;
  frameSize: number;
  workers: number;
  entryPerFrame?: boolean;
  offsetBase?: number;
  hashFrames?: boolean;
}): Promise<{ size: number; index: Buffer; hashes: string[] }> {
  if (entryPerFrame) {
    frameSize = 1;
  }
  const pool = createZstdFramePool(workers, params);
  const handle = await fsp.open(destination, offsetBase > 0 ? "a" : "w");
  const frames = new Map<number, ArrayBuffer>();
  const uncompressedSizes: number[] = [];
  const writtenFrames: Array<{ offset: number; size: number }> = [];
  const hashes: string[] = [];
  const submits: Array<Promise<unknown>> = [];
  let writeChain = Promise.resolve();
  let nextToWrite = 0;
  let written = 0;
  let failure: Error | undefined;
  let resumeReading: (() => void) | undefined;

  const wakeReader = () => {
    const resume = resumeReading;
    resumeReading = undefined;
    resume?.();
  };

  const flush = () => {
    for (
      let seqToWrite = nextToWrite;
      frames.has(seqToWrite);
      seqToWrite += 1
    ) {
      const frame = frames.get(seqToWrite)!;
      frames.delete(seqToWrite);
      nextToWrite += 1;
      writeChain = writeChain
        .then(async () => {
          // Writes are chained in sequence order, so `written` is stable here.
          writtenFrames[seqToWrite] = {
            offset: offsetBase + written,
            size: frame.byteLength,
          };
          written += frame.byteLength;
          const bytes = Buffer.from(frame);
          if (hashFrames) {
            hashes[seqToWrite] = createHash("sha256")
              .update(bytes)
              .digest("hex");
          }
          await handle.write(bytes);
        })
        .catch((error: Error) => {
          failure ??= error;
        });
    }
  };

  archive.on("error", (error) => {
    failure ??= error;
    wakeReader();
  });

  try {
    const carry: Buffer[] = [];
    let carryLength = 0;
    let seq = 0;
    let inFlight = 0;

    const submitFrame = (chunk: Buffer) => {
      if (chunk.length > MAX_ZSTD_FRAME_BYTES) {
        // Only a single tar entry this large can produce such a frame.
        throw new Error(
          `A payload entry needs a ${chunk.length}-byte frame, above the ${MAX_ZSTD_FRAME_BYTES}-byte v2 limit; use --payload-format v1.`,
        );
      }
      const currentSeq = seq;
      seq += 1;
      inFlight += 1;
      uncompressedSizes[currentSeq] = chunk.length;
      const submit = pool
        .submit(currentSeq, chunk)
        .then((compressed) => {
          frames.set(currentSeq, compressed);
          flush();
        })
        .finally(() => {
          inFlight -= 1;
          wakeReader();
        });
      submits.push(submit);
    };

    // Cut exactly at byte offsets that cannot depend on how the stream arrived
    // in chunks: frame-size multiples, or entry boundaries for v2.
    const takeFrame = (size: number): Buffer | undefined => {
      if (carryLength < size) {
        return undefined;
      }
      const [first] = carry;
      if (first.length === size) {
        carry.shift();
        carryLength -= size;
        return first;
      }
      const joined = Buffer.concat(carry, carryLength);
      const remainder = Buffer.from(joined.subarray(size));
      carry.splice(0, carry.length, remainder);
      carryLength = remainder.length;
      return joined.subarray(0, size);
    };

    // v2 framing tracks tar headers in the buffered bytes so a cut lands
    // between entries. Only the 512-byte headers are read; content passes
    // through untouched.
    const header = Buffer.alloc(512);
    let carryBase = 0; // absolute offset of carry[0]
    let parsePos = 0; // absolute offset of the next header to inspect
    // Absolute offsets where frames end, in order. A frame ends at the first
    // entry boundary at or after `frameSize` bytes from its start, which is a
    // function of the tar bytes alone: using "the latest boundary parsed so
    // far" instead would depend on how the stream happened to be chunked, and
    // chunking varies with backpressure, so with the worker count. pax ('x')
    // and GNU long-name/link ('L', 'K') records describe the entry that
    // follows them and are never a boundary: the stub would fail on "members
    // describing a future member" or extract under a truncated name.
    const cuts: number[] = [];
    let frameStart = 0;
    let endMarkerSeen = false;

    const parseTarHeaders = () => {
      while (!endMarkerSeen) {
        const headerOffset = parsePos - carryBase;
        if (carryLength - headerOffset < 512) {
          return;
        }
        if (carry[0].length >= headerOffset + 512) {
          header.set(carry[0].subarray(headerOffset, headerOffset + 512));
        } else {
          const parts: Buffer[] = [];
          let need = 512;
          let skip = headerOffset;
          for (const chunk of carry) {
            if (need <= 0) {
              break;
            }
            if (chunk.length <= skip) {
              // Whole chunk lies before the header.
              skip -= chunk.length;
              continue;
            }
            const take = Math.min(chunk.length - skip, need);
            parts.push(chunk.subarray(skip, skip + take));
            need -= take;
            skip = 0;
          }
          header.set(Buffer.concat(parts));
        }
        // All-zero header: end-of-archive. Never cut past it, so the final
        // frame always carries the end blocks.
        if (header.every((byte) => byte === 0)) {
          endMarkerSeen = true;
          return;
        }
        const typeflag = String.fromCharCode(header[156]);
        if (typeflag === "g") {
          // A global pax header applies to every later entry, which a frame
          // decoded on its own would never see.
          throw new Error(
            "Global pax headers are not supported by payload format v2; use --payload-format v1.",
          );
        }
        const entrySize = tarEntrySize(header);
        const entryTotal = 512 + Math.ceil(entrySize / 512) * 512;
        if (carryLength - headerOffset < entryTotal) {
          return;
        }
        parsePos += entryTotal;
        if (
          !["x", "L", "K"].includes(typeflag) &&
          parsePos - frameStart >= frameSize
        ) {
          cuts.push(parsePos);
          frameStart = parsePos;
        }
      }
    };

    for await (const chunk of archive) {
      carry.push(chunk);
      carryLength += chunk.length;
      parseTarHeaders();
      for (;;) {
        // Cuts are entry boundaries before the end-of-archive blocks, so those
        // always stay in the final frame.
        if (cuts.length === 0) {
          break;
        }
        const cutSize = cuts.shift()! - carryBase;
        if (inFlight >= workers) {
          await new Promise<void>((resolve) => {
            resumeReading = resolve;
          });
        }
        if (failure) {
          throw failure;
        }
        submitFrame(takeFrame(cutSize)!);
        carryBase += cutSize;
      }
    }

    if (entryPerFrame) {
      // Only the end-of-archive blocks remain; each lazy frame is decoded on
      // its own and must hold exactly one entry.
      if (!Buffer.concat(carry, carryLength).every((byte) => byte === 0)) {
        throw new Error("Lazy member stream did not end on an entry boundary.");
      }
    } else if (carryLength > 0 || seq === 0) {
      // The final frame also carries the tar end-of-archive blocks, even when
      // it is smaller than the frame size; an empty stream still gets one
      // frame.
      submitFrame(Buffer.concat(carry, carryLength));
    }

    await Promise.all(submits);
    await writeChain;
    if (failure) {
      throw failure;
    }
    const index = Buffer.alloc(writtenFrames.length * indexEntrySize);
    writtenFrames.forEach((frame, i) => {
      index.writeBigUInt64LE(BigInt(frame.offset), i * indexEntrySize);
      index.writeBigUInt64LE(BigInt(frame.size), i * indexEntrySize + 8);
      index.writeBigUInt64LE(
        BigInt(uncompressedSizes[i]),
        i * indexEntrySize + 16,
      );
    });
    return { size: written, index, hashes };
  } finally {
    await pool.destroy();
    await handle.close();
  }
}

// Size field of a tar header: octal at 124..136, or GNU base-256 when the
// high bit of the first byte is set.
function tarEntrySize(header: Buffer): number {
  if (header[124] & 0x80) {
    let size = header[124] & 0x7f;
    for (let i = 125; i < 136; i += 1) {
      size = size * 256 + header[i];
    }
    return size;
  }
  return Number.parseInt(header.subarray(124, 136).toString("utf8"), 8) || 0;
}

type ArchiveLike = Transform & {
  file(filename: string, data: { name: string; stats?: Stats }): unknown;
  append(
    source: Buffer,
    data: { name: string; type: "symlink"; linkname: string; date?: Date },
  ): unknown;
  finalize(): Promise<void>;
};

// archiver v8 is ESM-only and exposes named exports at runtime, while
// @types/archiver still models the older default-export factory API.
const { TarArchive } = archiverModule as unknown as {
  TarArchive: new () => ArchiveLike;
};

type PayloadCompression = "gzip" | "zstd";

const darwinSystemLibraryPrefixes = ["/System/Library/", "/usr/lib/"];
const linuxSystemLibraryPrefixes = ["/lib", "/lib64", "/usr/lib", "/usr/lib64"];

function resolveUpxCommand(): { command: string; shell?: boolean } {
  if (process.platform !== "win32") {
    return { command: "upx" };
  }

  const pathKey = Object.keys(process.env).find(
    (key) => key.toLowerCase() === "path",
  );
  const pathValue = pathKey ? (process.env[pathKey] ?? "") : "";
  const pathExtensions = (
    process.env.PATHEXT?.split(";") ?? [".COM", ".EXE", ".BAT", ".CMD"]
  )
    .filter(Boolean)
    .map((extension) => extension.toLowerCase());
  const candidateNames = [
    "upx",
    ...pathExtensions.map((extension) => `upx${extension}`),
  ];

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }

    for (const candidateName of candidateNames) {
      const candidatePath = path.join(directory, candidateName);
      if (!existsSync(candidatePath)) {
        continue;
      }

      const extension = path.extname(candidatePath).toLowerCase();
      return {
        command: candidatePath,
        shell: extension === ".cmd" || extension === ".bat",
      };
    }
  }

  return { command: "upx" };
}

async function runUpx(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const { command, shell } = resolveUpxCommand();
    const upxProcess = spawn(command, [...args, file], {
      shell,
      stdio: "inherit",
    });

    upxProcess.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new Error(
            "UPX command not found. Please install UPX and ensure it is in your system's PATH.",
          ),
        );
      } else {
        reject(error);
      }
    });

    upxProcess.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`UPX process exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

const defaultExcludes = [
  ".*",
  "*.exe",
  "*.exe.sha256",
  "*.exe.sha512",
  "*.sha256",
  "*.sha512",
  "cdxgen*",
  "cdxgen-*",
  "cdxgen-secure*",
  "cdx-*",
  "hbom*",
  "cdxgen-arm64*",
  "cdx-arm64*",
  "*.yml",
  "*.sh",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "deno.json",
  "jsr.json",
  ".git/**",
  ".github/**",
  ".vscode/**",
  "**/*/*.env",
  "contrib/**",
  "docs/**",
  "test/**",
  "types/**",
  "binary-metadata.json",
  "node_modules/*/.github/**",
  "node_modules/*/.vscode/**",
  "node_modules/*/doc/**",
  "node_modules/*/docs/**",
  "node_modules/*/test/**",
  "node_modules/*/tests/**",
  "node_modules/*/__tests__/**",
  "node_modules/*/testing/**",
  "node_modules/*/example/**",
  "node_modules/*/examples/**",
  "node_modules/*/benchmark/**",
  "node_modules/*/benchmarks/**",
  "node_modules/@*/*/.github/**",
  "node_modules/@*/*/.vscode/**",
  "node_modules/@*/*/doc/**",
  "node_modules/@*/*/docs/**",
  "node_modules/@*/*/test/**",
  "node_modules/@*/*/tests/**",
  "node_modules/@*/*/__tests__/**",
  "node_modules/@*/*/testing/**",
  "node_modules/@*/*/example/**",
  "node_modules/@*/*/examples/**",
  "node_modules/@*/*/benchmark/**",
  "node_modules/@*/*/benchmarks/**",
  "node_modules/**/*.d.ts",
  "node_modules/**/*.d.mts",
  "node_modules/**/*.d.cts",
  // TypeScript / Flow sources are never loaded by the Node runtime. License and
  // NOTICE files are intentionally kept for compliance and SBOM fidelity.
  "node_modules/**/*.ts",
  "node_modules/**/*.mts",
  "node_modules/**/*.cts",
  "node_modules/**/*.flow",
  "node_modules/**/*.tsbuildinfo",
  "node_modules/**/*.map",
  "node_modules/**/*.js.map",
  "node_modules/**/*.md",
  "node_modules/**/*.markdown",
  "node_modules/**/README",
  "node_modules/**/README.*",
  "node_modules/**/CHANGELOG",
  "node_modules/**/CHANGELOG.*",
  "node_modules/**/CHANGES",
  "node_modules/**/CHANGES.*",
  "node_modules/**/HISTORY",
  "node_modules/**/HISTORY.*",
  "node_modules/**/AUTHORS",
  "node_modules/**/AUTHORS.*",
  "node_modules/**/CONTRIBUTORS",
  "node_modules/**/CONTRIBUTORS.*",
  // Tooling / editor config that ships inside packages but is inert at runtime.
  "node_modules/**/tsconfig.json",
  "node_modules/**/tsconfig.*.json",
  "node_modules/**/.editorconfig",
  "node_modules/**/.eslintrc",
  "node_modules/**/.eslintrc.*",
  "node_modules/**/.eslintignore",
  "node_modules/**/.prettierrc",
  "node_modules/**/.prettierrc.*",
  "node_modules/**/.prettierignore",
  "node_modules/**/.babelrc",
  "node_modules/**/.babelrc.*",
  "node_modules/**/.npmignore",
  "node_modules/**/.gitattributes",
  "node_modules/**/.nvmrc",
  "node_modules/**/.nycrc",
  "node_modules/**/.nycrc.*",
  "node_modules/**/.travis.yml",
  "bom.json",
  "biome.json",
  "jest.config.js",
];

interface Component {
  group: string | undefined;
  name: string;
  description?: string;
  license?: string;
  version?: string;
  purl: string;
  "bom-ref": string;
  author?: string;
  type?: string;
  scope?: string;
  cpe?: string;
  components?: Component[];
  properties?: Array<{
    name: string;
    value: string;
  }>;
  externalReferences?: Array<{
    url: string;
    type: string;
    comment?: string;
  }>;
}

interface DependencyGraphEntry {
  ref: string;
  dependsOn: string[];
}

// A lazy member: an executable packed in its own frame at the end of the
// payload. The v2 stub writes a small placeholder on a cold start and decodes
// the frame the first time the placeholder runs. `sha256` is over the frame's
// compressed bytes.
interface LazyMember {
  path: string;
  frame: number;
  mode: number;
  size: number;
  sha256: string;
}

interface TargetOptions {
  output: string;
  command: string[];
  metadataFile?: string;
  force?: boolean;
  identifier?: string;
  uncompressionMessage?: string;
}

interface CommonBuildOptions {
  input: string;
  exclude?: string[];
  includeNode?: boolean;
  stub?: string;
  compression?: PayloadCompression;
  payloadFormat?: PayloadFormat;
  lazy?: string[];
  upx?: boolean;
  upxArgs?: string[];
}

interface PortableNodeBundle {
  root: string;
}

interface CliOptions {
  input?: string;
  output?: string;
  targetsFile?: string;
  metadataFile: string;
  force: boolean;
  exclude?: string[];
  includeNode: boolean;
  stub?: string;
  identifier?: string;
  removeBuildDirectory: boolean;
  uncompressionMessage?: string;
  upx: boolean;
  upxArgs?: string[];
  compression?: PayloadCompression;
  payloadFormat?: PayloadFormat;
  lazy?: string[];
}

interface ParsedCliArguments {
  options: CliOptions;
  command: string[];
  showHelp: boolean;
  showVersion: boolean;
}

function randomToken(length: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(length);
  let token = "";

  for (const byte of bytes) {
    token += alphabet[byte % alphabet.length];
  }

  return token;
}

function stripIndent(
  strings: TemplateStringsArray,
  ...values: Array<string | number | undefined>
): string {
  const fullText = strings.reduce((result, stringPart, index) => {
    const value = index < values.length ? String(values[index] ?? "") : "";
    return result + stringPart + value;
  }, "");
  const lines = fullText.replace(/^\n/, "").split("\n");
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => line.match(/^\s*/)?.[0].length ?? 0);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;

  return lines
    .map((line) => line.slice(minIndent))
    .join("\n")
    .trimEnd();
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function removePath(targetPath: string): Promise<void> {
  await fsp.rm(targetPath, { recursive: true, force: true });
}

async function readJsonFile(filePath: string): Promise<any> {
  return JSON.parse(await fsp.readFile(filePath, "utf8"));
}

async function writeJsonFile(
  filePath: string,
  value: unknown,
  spaces = 0,
): Promise<void> {
  await fsp.writeFile(filePath, JSON.stringify(value, null, spaces), "utf8");
}

function matchesGlobCompat(targetPath: string, pattern: string): boolean {
  return (
    path.matchesGlob(targetPath, pattern) ||
    (pattern.startsWith("**/") &&
      path.matchesGlob(targetPath, pattern.slice(3)))
  );
}

function isExcludedPath(relativePath: string, exclude: string[]): boolean {
  const normalizedPath = normalizeArchivePath(relativePath);
  const segments = normalizedPath.split("/");
  const ancestors: string[] = [];

  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }

  return exclude.some(
    (pattern) =>
      matchesGlobCompat(normalizedPath, pattern) ||
      ancestors.some((ancestor) => matchesGlobCompat(ancestor, pattern)),
  );
}

function shouldPruneDirectory(
  relativePath: string,
  exclude: string[],
): boolean {
  const normalizedPath = normalizeArchivePath(relativePath);

  return exclude.some(
    (pattern) =>
      matchesGlobCompat(normalizedPath, pattern) ||
      matchesGlobCompat(`${normalizedPath}/__caxa_probe__`, pattern),
  );
}

async function walkFiles(
  root: string,
  current: string,
  exclude: string[],
  files: string[],
): Promise<void> {
  const entries = await fsp.readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = normalizeArchivePath(
      path.relative(root, absolutePath),
    );

    if (entry.isDirectory()) {
      if (shouldPruneDirectory(relativePath, exclude)) {
        continue;
      }
      await walkFiles(root, absolutePath, exclude, files);
      continue;
    }

    if (isExcludedPath(relativePath, exclude)) {
      continue;
    }

    if (entry.isFile() || entry.isSymbolicLink()) {
      files.push(relativePath);
    }
  }
}

async function copyEntry(
  sourcePath: string,
  destinationPath: string,
): Promise<void> {
  const stats = await fsp.lstat(sourcePath);
  await ensureDir(path.dirname(destinationPath));

  if (stats.isSymbolicLink()) {
    const linkTarget = await fsp.readlink(sourcePath);
    await removePath(destinationPath);
    await fsp.symlink(linkTarget, destinationPath);
    return;
  }

  await fsp.copyFile(sourcePath, destinationPath);
  await fsp.chmod(destinationPath, stats.mode);
}

async function setDeterministicFileTimes(filePath: string): Promise<void> {
  const fixedTimestamp = new Date(0);
  await fsp.utimes(filePath, fixedTimestamp, fixedTimestamp);
}

function createCliHelpText(version: string): string {
  return stripIndent`
    Usage: caxa [options] [command...]

    Package Node.js applications into executable binaries

    Arguments:
      command                                The command to run. Paths must be absolute.
                                             The '{{caxa}}' placeholder is substituted for the extraction directory.
                                             The 'node' executable is available at '{{caxa}}/node_modules/.bin/node'.

    Options:
      -i, --input <input>                    [Required] Input directory to package.
      -o, --output <output>                  Path where the executable will be produced.
                                             On Windows, must end in '.exe'.
      --targets-file <path>                  JSON file describing multiple native outputs to build from a single payload.
      --metadata-file <path>                 Metadata file name for capturing npm components and dependencies in the bundled binary.
      -F, --no-force                         Don’t overwrite output if it exists.
      -e, --exclude <path...>                Paths to exclude from the build.
      -N, --no-include-node                  Don’t copy the Node.js executable.
      -s, --stub <path>                      Path to the stub.
      --identifier <id>                      Build identifier.
      -B, --no-remove-build-directory        Ignored in v3 (streaming build).
      -m, --uncompression-message <msg>      Message to show during extraction.
      --upx                                  Compress the output binary with UPX.
      --upx-args <args...>                   Arguments to pass to UPX (e.g., '--best --lzma').
      -c, --compression <type>               Payload compression: 'gzip' or 'zstd'. Native outputs default to 'zstd'.
      --payload-format <format>              Payload format: 'v1' (single stream) or 'v2' (frames with an index, default for
                                             native zstd payloads). 'v2' requires zstd and native outputs.
      --lazy <glob>                          Executables (relative to --input) to extract on first use instead of on
                                             a cold start. Repeatable; requires the v2 payload format. CAXA_LAZY adds
                                             newline- or comma-separated globs.
      -V, --version                          Output the version number.
      -h, --help                             Display help for command.

    Version:
      ${version}
  `;
}

function parseCompressionOption(
  compression: string | undefined,
): PayloadCompression | undefined {
  if (compression === undefined) {
    return undefined;
  }

  if (compression !== "gzip" && compression !== "zstd") {
    throw new Error(
      `Unsupported compression '${compression}'. Expected 'gzip' or 'zstd'.`,
    );
  }

  return compression;
}

function parsePayloadFormatOption(
  format: string | undefined,
): PayloadFormat | undefined {
  if (format === undefined) {
    return undefined;
  }

  if (format !== "v1" && format !== "v2") {
    throw new Error(
      `Unsupported payload format '${format}'. Expected 'v1' or 'v2'.`,
    );
  }

  return format;
}

// v2 payloads are a native-output zstd feature; .sh and .app outputs keep
// their previous layout no matter what the default says.
function resolvePayloadFormat(
  requested: PayloadFormat | undefined,
  output: string,
): PayloadFormat {
  if (requested === "v2") {
    if (output.endsWith(".app") || output.endsWith(".sh")) {
      throw new Error(
        `Payload format 'v2' supports native outputs only; '${output}' keeps the previous format. Use 'v1' or omit the option.`,
      );
    }
    return "v2";
  }
  if (requested === "v1") {
    return "v1";
  }
  return output.endsWith(".app") || output.endsWith(".sh") ? "v1" : "v2";
}

function normalizeCliOptionArgs(args: string[]): string[] {
  const cliOptionTokens = new Set([
    "--input",
    "-i",
    "--output",
    "-o",
    "--targets-file",
    "--metadata-file",
    "--no-force",
    "-F",
    "--exclude",
    "-e",
    "--no-include-node",
    "-N",
    "--stub",
    "-s",
    "--identifier",
    "--no-remove-build-directory",
    "-B",
    "--uncompression-message",
    "-m",
    "--upx",
    "--upx-args",
    "--compression",
    "-c",
    "--payload-format",
    "--lazy",
    "--version",
    "-V",
    "--help",
    "-h",
  ]);
  const normalized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const currentArg = args[index];
    if (
      currentArg !== "--exclude" &&
      currentArg !== "-e" &&
      currentArg !== "--upx-args"
    ) {
      normalized.push(currentArg);
      continue;
    }

    const acceptsOptionLikeValues = currentArg === "--upx-args";
    const values: string[] = [];
    for (let cursor = index + 1; cursor < args.length; cursor += 1) {
      const candidate = args[cursor];
      if (
        (!acceptsOptionLikeValues && candidate.startsWith("-")) ||
        (acceptsOptionLikeValues && cliOptionTokens.has(candidate))
      ) {
        break;
      }
      values.push(candidate);
      index = cursor;
    }

    if (values.length === 0) {
      normalized.push(currentArg);
      continue;
    }

    for (const value of values) {
      if (currentArg === "--upx-args") {
        normalized.push(`--upx-args=${value}`);
        continue;
      }
      normalized.push(currentArg, value);
    }
  }

  return normalized;
}

function parseCliArguments(argv: string[]): ParsedCliArguments {
  const separatorIndex = argv.indexOf("--");
  const optionArgs =
    separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const separatorCommand =
    separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
  const normalizedOptionArgs = normalizeCliOptionArgs(optionArgs);

  const { values, positionals } = parseArgs({
    args: normalizedOptionArgs,
    allowPositionals: true,
    strict: true,
    options: {
      input: { type: "string", short: "i" },
      output: { type: "string", short: "o" },
      "targets-file": { type: "string" },
      "metadata-file": { type: "string" },
      "no-force": { type: "boolean", short: "F" },
      exclude: { type: "string", short: "e", multiple: true },
      "no-include-node": { type: "boolean", short: "N" },
      stub: { type: "string", short: "s" },
      identifier: { type: "string" },
      "no-remove-build-directory": { type: "boolean", short: "B" },
      "uncompression-message": { type: "string", short: "m" },
      upx: { type: "boolean" },
      "upx-args": { type: "string", multiple: true },
      compression: { type: "string", short: "c" },
      "payload-format": { type: "string" },
      lazy: { type: "string", multiple: true },
      version: { type: "boolean", short: "V" },
      help: { type: "boolean", short: "h" },
    },
  });

  return {
    options: {
      input: values.input,
      output: values.output,
      targetsFile: values["targets-file"],
      metadataFile: values["metadata-file"] ?? "binary-metadata.json",
      force: values["no-force"] ? false : true,
      exclude: values.exclude,
      includeNode: values["no-include-node"] ? false : true,
      stub: values.stub,
      identifier: values.identifier,
      removeBuildDirectory: values["no-remove-build-directory"] ? false : true,
      uncompressionMessage: values["uncompression-message"],
      upx: values.upx ?? false,
      upxArgs: values["upx-args"],
      compression: parseCompressionOption(values.compression),
      payloadFormat: parsePayloadFormatOption(values["payload-format"]),
      lazy: values.lazy,
    },
    command: separatorCommand.length > 0 ? separatorCommand : positionals,
    showHelp: values.help ?? false,
    showVersion: values.version ?? false,
  };
}

function normalizeUpxArgs(args: string[]): string[] {
  return args
    .flatMap((arg) => arg.split(/\s+/))
    .filter((arg) => arg.length > 0);
}

function createIdentifier(output: string): string {
  return path.join(
    path.basename(path.basename(path.basename(output, ".exe"), ".app"), ".sh"),
    randomToken(10),
  );
}

async function createContentAddressedIdentifier(
  payloadPath: string,
): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(payloadPath)) {
    hash.update(chunk);
  }

  return `sha256-${hash.digest("hex").slice(0, 32)}`;
}

function normalizeArchivePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function createPayloadTempPath(
  outputDirectory: string,
  compression: PayloadCompression,
): string {
  return path.join(
    outputDirectory,
    `.caxa-payload-${randomToken(12)}.tar.${compression === "zstd" ? "zst" : "gz"}`,
  );
}

function resolveCompressionForOutput(
  output: string,
  requestedCompression?: PayloadCompression,
): PayloadCompression {
  if (requestedCompression) {
    return requestedCompression;
  }

  return output.endsWith(".sh") ? "gzip" : "zstd";
}

function assertCompressionSupported(
  output: string,
  compression: PayloadCompression,
): void {
  if (output.endsWith(".sh") && compression !== "gzip") {
    throw new Error(
      "Shell stub outputs (.sh) currently support gzip payloads only. Use --compression gzip.",
    );
  }
}

async function runCommandCapture(
  command: string,
  args: string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      const cause =
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? `Required command '${command}' was not found in PATH.`
          : (error as Error).message;
      reject(new Error(cause));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

function rememberPortableDependency(
  seenDependencies: Map<string, string>,
  dependencyPath: string,
): void {
  const fileName = path.basename(dependencyPath);
  const existing = seenDependencies.get(fileName);
  if (existing && existing !== dependencyPath) {
    throw new Error(
      `Portable Node bundling found conflicting libraries with the same name '${fileName}': '${existing}' and '${dependencyPath}'.`,
    );
  }

  seenDependencies.set(fileName, dependencyPath);
}

async function resolveExistingPath(
  filePath: string | undefined,
): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }

  if (!(await pathExists(filePath))) {
    return undefined;
  }

  return fsp.realpath(filePath).catch(() => filePath);
}

async function resolveDarwinDependencyReference(
  dependencyReference: string,
  currentFile: string,
  executablePath: string,
): Promise<string | undefined> {
  const normalizedReference = dependencyReference.trim();

  if (normalizedReference.startsWith("/")) {
    return resolveExistingPath(normalizedReference);
  }

  if (normalizedReference.startsWith("@loader_path/")) {
    return resolveExistingPath(
      path.join(
        path.dirname(currentFile),
        normalizedReference.slice("@loader_path/".length),
      ),
    );
  }

  if (normalizedReference.startsWith("@executable_path/")) {
    return resolveExistingPath(
      path.join(
        path.dirname(executablePath),
        normalizedReference.slice("@executable_path/".length),
      ),
    );
  }

  if (!normalizedReference.startsWith("@rpath/")) {
    return undefined;
  }

  const rpathOutput = await runCommandCapture("otool", ["-l", currentFile]);
  const lines = rpathOutput.split(/\r?\n/);
  const suffix = normalizedReference.slice("@rpath/".length);

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes("cmd LC_RPATH")) {
      continue;
    }

    for (
      let cursor = index + 1;
      cursor < Math.min(index + 5, lines.length);
      cursor += 1
    ) {
      const match = lines[cursor].match(/^\s*path\s+(.+?)\s+\(offset /);
      if (!match) {
        continue;
      }

      const rawRpath = match[1].trim();
      const resolvedRpath = await resolveDarwinDependencyReference(
        rawRpath,
        currentFile,
        executablePath,
      );
      if (!resolvedRpath) {
        break;
      }

      const resolvedCandidate = await resolveExistingPath(
        path.join(resolvedRpath, suffix),
      );
      if (resolvedCandidate) {
        return resolvedCandidate;
      }
      break;
    }
  }

  const fallbackCandidates = [
    path.join(path.dirname(currentFile), "..", "lib", path.basename(suffix)),
    path.join(path.dirname(executablePath), "..", "lib", path.basename(suffix)),
  ];

  for (const candidate of fallbackCandidates) {
    const resolvedCandidate = await resolveExistingPath(candidate);
    if (resolvedCandidate) {
      return resolvedCandidate;
    }
  }

  return undefined;
}

async function collectDarwinRuntimeLibraries(
  executablePath: string,
): Promise<string[]> {
  const pending = [await fsp.realpath(executablePath)];
  const scanned = new Set<string>();
  const collected = new Map<string, string>();

  while (pending.length > 0) {
    const currentFile = pending.shift()!;
    if (scanned.has(currentFile)) {
      continue;
    }
    scanned.add(currentFile);

    const output = await runCommandCapture("otool", ["-L", currentFile]);
    const lines = output.split(/\r?\n/).slice(1);
    for (const line of lines) {
      const dependencyReference = line.trim().split(" ")[0];
      if (!dependencyReference) {
        continue;
      }

      const resolvedDependency = await resolveDarwinDependencyReference(
        dependencyReference,
        currentFile,
        executablePath,
      );
      if (!resolvedDependency) {
        continue;
      }

      if (
        darwinSystemLibraryPrefixes.some((prefix) =>
          resolvedDependency.startsWith(prefix),
        )
      ) {
        continue;
      }

      rememberPortableDependency(collected, resolvedDependency);
      pending.push(resolvedDependency);
    }
  }

  return [...collected.values()].sort();
}

async function collectLinuxRuntimeLibraries(
  executablePath: string,
): Promise<string[]> {
  const pending = [await fsp.realpath(executablePath)];
  const scanned = new Set<string>();
  const collected = new Map<string, string>();

  while (pending.length > 0) {
    const currentFile = pending.shift()!;
    if (scanned.has(currentFile)) {
      continue;
    }
    scanned.add(currentFile);

    const output = await runCommandCapture("ldd", [currentFile]);
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("linux-vdso")) {
        continue;
      }
      if (trimmed.includes("=> not found")) {
        throw new Error(
          `Portable Node bundling failed because a shared library was missing: ${trimmed}`,
        );
      }

      let dependencyPath: string | undefined;
      if (trimmed.includes("=>")) {
        const candidate = trimmed.split("=>")[1]?.trim().split(" ")[0];
        if (candidate?.startsWith("/")) {
          dependencyPath = candidate;
        }
      } else if (trimmed.startsWith("/")) {
        dependencyPath = trimmed.split(" ")[0];
      }

      const resolvedDependency = await resolveExistingPath(dependencyPath);
      if (!resolvedDependency) {
        continue;
      }

      if (
        linuxSystemLibraryPrefixes.some((prefix) =>
          resolvedDependency.startsWith(prefix),
        )
      ) {
        continue;
      }

      rememberPortableDependency(collected, resolvedDependency);
      pending.push(resolvedDependency);
    }
  }

  return [...collected.values()].sort();
}

async function preparePortableNodeBundle({
  stagingParent,
  upx,
  upxArgs,
}: {
  stagingParent: string;
  upx: boolean;
  upxArgs: string[];
}): Promise<PortableNodeBundle> {
  const nodePath = await fsp.realpath(process.execPath);
  const bundleRoot = path.join(stagingParent, `.caxa-node-${randomToken(12)}`);
  const binDir = path.join(bundleRoot, "node_modules", ".bin");
  await ensureDir(binDir);

  if (process.platform === "win32") {
    const nodeDestination = path.join(binDir, path.basename(nodePath));
    await fsp.copyFile(nodePath, nodeDestination);
    await fsp.chmod(nodeDestination, 0o755);
    await setDeterministicFileTimes(nodeDestination);

    for (const entry of await fsp.readdir(path.dirname(nodePath))) {
      if (!entry.toLowerCase().endsWith(".dll")) {
        continue;
      }
      const destinationPath = path.join(binDir, entry);
      await fsp.copyFile(
        path.join(path.dirname(nodePath), entry),
        destinationPath,
      );
      await setDeterministicFileTimes(destinationPath);
    }

    // Intentionally not UPX-compressing the Node executable: UPX must
    // decompress the whole binary into memory on every launch (slower cold
    // start, higher RSS) and breaks code signing / notarization while
    // triggering AV false positives. The zstd payload already compresses it on
    // disk. UPX is still applied to the small runtime stub in buildNativeOutput.
    return { root: bundleRoot };
  }

  const wrapperName = path.basename(nodePath);
  const nodeRealDestination = path.join(binDir, `${wrapperName}-real`);
  const nodeLibDir = path.join(binDir, `${wrapperName}-libs`);
  await ensureDir(nodeLibDir);
  await fsp.copyFile(nodePath, nodeRealDestination);
  await fsp.chmod(nodeRealDestination, 0o755);
  await setDeterministicFileTimes(nodeRealDestination);

  // See note above: the Node executable is deliberately left uncompressed.
  const runtimeLibraries =
    process.platform === "darwin"
      ? await collectDarwinRuntimeLibraries(nodePath)
      : await collectLinuxRuntimeLibraries(nodePath);

  for (const libraryPath of runtimeLibraries) {
    const destinationPath = path.join(nodeLibDir, path.basename(libraryPath));
    await fsp.copyFile(libraryPath, destinationPath);
    await setDeterministicFileTimes(destinationPath);
  }

  const envVariableName =
    process.platform === "darwin" ? "DYLD_LIBRARY_PATH" : "LD_LIBRARY_PATH";
  await fsp.writeFile(
    path.join(binDir, wrapperName),
    stripIndent`
      #!/usr/bin/env sh
      export CAXA_NODE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
      export ${envVariableName}="$CAXA_NODE_DIR/${wrapperName}-libs${`$`}{${envVariableName}:+:${`$`}{${envVariableName}}}"
      exec "$CAXA_NODE_DIR/${wrapperName}-real" "$@"
    ` + "\n",
    { mode: 0o755 },
  );
  await setDeterministicFileTimes(path.join(binDir, wrapperName));

  return { root: bundleRoot };
}

async function appendDirectoryContentsToArchive(
  archive: ArchiveLike,
  root: string,
): Promise<void> {
  const files = await collectFiles(root, []);

  for (const file of files) {
    const absolutePath = path.join(root, file);
    archive.file(absolutePath, {
      name: normalizeArchivePath(file),
      stats: await fsp.stat(absolutePath),
    });
  }
}

async function copyDirectoryContents(
  source: string,
  destination: string,
): Promise<void> {
  const files = await collectFiles(source, []);

  for (const file of files) {
    const sourcePath = path.join(source, file);
    const destinationPath = path.join(destination, file);
    await copyEntry(sourcePath, destinationPath);
  }
}

async function validateOutput(output: string, force: boolean): Promise<void> {
  if ((await pathExists(output)) && !force)
    throw new Error(`Output already exists: ‘${output}’.`);
  if (process.platform === "win32" && !output.endsWith(".exe"))
    throw new Error("Windows executable must end in ‘.exe’.");

  await ensureDir(path.dirname(output));
  await removePath(output);
}

async function collectFiles(
  input: string,
  exclude: string[],
): Promise<string[]> {
  const files: string[] = [];
  await walkFiles(input, input, exclude, files);
  return files.sort((left, right) => left.localeCompare(right));
}

async function collectMetadata(
  input: string,
  files: string[],
  includeNode: boolean,
): Promise<{
  components: Component[];
  dependencies: DependencyGraphEntry[];
}> {
  const componentsWithRawDeps: Array<
    Component & {
      _rawDeps?: Record<string, string>;
    }
  > = [];
  const bomRefLookup = new Map<string, string>();

  if (includeNode) {
    componentsWithRawDeps.push(getRuntimeInformation());
  }

  for (const file of files) {
    if (path.basename(file) !== "package.json") {
      continue;
    }

    try {
      const pkg = await readJsonFile(path.join(input, file));
      if (!pkg.name || !pkg.version) {
        continue;
      }

      let name = pkg.name;
      let namespace = "";
      if (name.startsWith("@")) {
        const parts = name.split("/");
        namespace = parts[0];
        name = parts[1];
      }

      let purl = "pkg:npm/";
      let bomRef = "pkg:npm/";
      if (namespace) {
        purl += `${encodeURIComponent(namespace)}/`;
        bomRef += `${namespace}/`;
      }
      purl += `${name}@${pkg.version}`;
      bomRef += `${name}@${pkg.version}`;
      bomRefLookup.set(pkg.name, bomRef);

      const author = pkg.author;
      const authorString =
        author instanceof Object
          ? `${author.name}${author.email ? ` <${author.email}>` : ""}${
              author.url ? ` (${author.url})` : ""
            }`
          : author;

      componentsWithRawDeps.push({
        group: namespace,
        name,
        description: pkg.description,
        license: pkg.license,
        version: pkg.version,
        purl,
        "bom-ref": bomRef,
        author: authorString,
        _rawDeps: pkg.dependencies,
      });
    } catch {
      // Ignore malformed package.json files.
    }
  }

  const dependencies: DependencyGraphEntry[] = [];
  const components: Component[] = [];

  for (const component of componentsWithRawDeps) {
    const childRefs: string[] = [];
    if (component._rawDeps) {
      for (const depName of Object.keys(component._rawDeps)) {
        const resolvedRef = bomRefLookup.get(depName);
        if (resolvedRef) {
          childRefs.push(resolvedRef);
        }
      }
    }

    const { _rawDeps, ...sanitizedComponent } = component;
    components.push(sanitizedComponent);

    if (childRefs.length > 0) {
      dependencies.push({
        ref: component["bom-ref"],
        dependsOn: childRefs,
      });
    }
  }

  return { components, dependencies };
}

async function writeMetadataFile({
  input,
  output,
  metadataFile,
  components,
  dependencies,
}: {
  input: string;
  output: string;
  metadataFile: string;
  components: Component[];
  dependencies: DependencyGraphEntry[];
}): Promise<void> {
  await writeJsonFile(
    path.join(path.dirname(output), metadataFile),
    {
      parentComponent: getParentComponent(input, output),
      components,
      dependencies,
    },
    0,
  );
}

// Only framed v2 zstd payloads have an index the stub can skip frames with.
function isFramedPayload(
  compression: PayloadCompression,
  payloadFormat: PayloadFormat,
): boolean {
  return (
    compression === "zstd" && payloadFormat === "v2" && zstdWorkerCount() > 0
  );
}

// CAXA_LAZY lets a build script pass lazy globs without new flags: newline-
// or comma-separated, appended to the --lazy values.
function lazyPatternsFromEnv(): string[] {
  return (process.env.CAXA_LAZY ?? "")
    .split(/[\n,]/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Picks the lazy members, sorted by path. Only regular files with an exec bit
// qualify; other matches are packed normally and listed. A --lazy pattern
// that matches no executable fails the build. A CAXA_LAZY pattern that
// matches none is only reported, because one environment is applied to every
// target and slim targets lack some files.
async function selectLazyMembers({
  input,
  files,
  patterns,
  framed,
  output,
}: {
  input: string;
  files: string[];
  patterns: string[];
  framed: boolean;
  output: string;
}): Promise<string[]> {
  const envPatterns = lazyPatternsFromEnv();
  if (patterns.length === 0 && envPatterns.length === 0) {
    return [];
  }
  if (!framed) {
    if (patterns.length > 0) {
      throw new Error(
        `--lazy requires the v2 payload format with zstd frames, which ‘${output}’ does not use.`,
      );
    }
    console.warn(
      `caxa: CAXA_LAZY ignored for ‘${output}’: lazy members require the v2 payload format with zstd frames.`,
    );
    return [];
  }

  const all = [
    ...patterns.map((pattern) => ({ pattern, fromEnv: false })),
    ...envPatterns.map((pattern) => ({ pattern, fromEnv: true })),
  ];
  const lazy: string[] = [];
  const packedNormally: string[] = [];
  const matched = new Set<(typeof all)[number]>();
  for (const file of files) {
    const hits = all.filter(({ pattern }) => matchesGlobCompat(file, pattern));
    if (hits.length === 0) {
      continue;
    }
    const stats = await fsp.lstat(path.join(input, file));
    if (stats.isFile() && (stats.mode & 0o111) !== 0) {
      lazy.push(file);
      for (const hit of hits) {
        matched.add(hit);
      }
    } else {
      packedNormally.push(file);
    }
  }

  const unmatched = all.filter((entry) => !matched.has(entry));
  const failing = unmatched.filter(({ fromEnv }) => !fromEnv);
  if (failing.length > 0) {
    throw new Error(
      `--lazy pattern matches no executable regular file: ${failing.map(({ pattern }) => `‘${pattern}’`).join(", ")}.`,
    );
  }
  for (const { pattern } of unmatched) {
    console.warn(
      `caxa: CAXA_LAZY pattern ‘${pattern}’ matches no executable regular file in ‘${input}’.`,
    );
  }
  lazy.sort(compareCodeUnits);
  if (lazy.length > 0) {
    console.log(`caxa: lazy members (${lazy.length}):`);
    for (const file of lazy) {
      console.log(`  ${file}`);
    }
  }
  if (packedNormally.length > 0) {
    console.log(
      `caxa: matched by lazy patterns but packed normally (not executable regular files) (${packedNormally.length}):`,
    );
    for (const file of packedNormally) {
      console.log(`  ${file}`);
    }
  }
  return lazy;
}

async function createPayloadArchive({
  input,
  files,
  destination,
  includeNode,
  compression,
  payloadFormat,
  upx,
  upxArgs,
  lazy = [],
}: {
  input: string;
  files: string[];
  destination: string;
  includeNode: boolean;
  compression: PayloadCompression;
  payloadFormat: PayloadFormat;
  upx: boolean;
  upxArgs: string[];
  lazy?: string[];
}): Promise<{
  size: number;
  index: Buffer | null;
  lazy: LazyMember[];
}> {
  const archive = new TarArchive();
  // Native zstd payloads default to v2: fixed-size frames ending on tar entry
  // boundaries, so the stub can decode and extract them in parallel. The v1
  // single-stream payload remains available via --payload-format v1 (and is
  // the only format for gzip payloads).
  const framed = isFramedPayload(compression, payloadFormat);
  if (lazy.length > 0 && !framed) {
    throw new Error("Lazy members require a framed v2 zstd payload.");
  }
  const lazySet = new Set(lazy);
  let payloadResult:
    Promise<{ size: number; index: Buffer | null }> | undefined;
  let completion: Promise<unknown>;
  if (framed) {
    payloadResult = compressStreamInFrames({
      archive,
      destination,
      params: zstdCompressOptions().params,
      frameSize: zstdFrameBytes(),
      workers: zstdWorkerCount(),
    });
    completion = payloadResult;
  } else {
    completion = stream.pipeline(
      archive,
      compression === "zstd"
        ? createZstdCompress(zstdCompressOptions())
        : createGzip({ level: 9 }),
      createWriteStream(destination),
    );
  }

  archive.on("warning", (warning) => {
    if ((warning as NodeJS.ErrnoException).code !== "ENOENT") {
      archive.emit("error", warning);
    }
  });

  const tempPathsCleanup: string[] = [];

  for (const file of files) {
    if (lazySet.has(file)) {
      continue;
    }
    const absPath = path.join(input, file);
    const name = normalizeArchivePath(file);
    const stats = await fsp.lstat(absPath);
    if (stats.isSymbolicLink()) {
      const linkTarget = await fsp.readlink(absPath);
      // archiver's symlink() stamps entries with the build time, so the
      // payload bytes and the content-addressed identifier would differ on
      // every build. append() with an explicit date keeps the payload
      // deterministic; the header mode default matches symlink().
      archive.append(Buffer.alloc(0), {
        name,
        type: "symlink",
        linkname: linkTarget,
        date: stats.mtime,
      });
    } else {
      archive.file(absPath, { name, stats });
    }
  }

  if (includeNode) {
    const bundle = await preparePortableNodeBundle({
      stagingParent: path.dirname(destination),
      upx,
      upxArgs,
    });
    tempPathsCleanup.push(bundle.root);
    await appendDirectoryContentsToArchive(archive, bundle.root);
  }

  await archive.finalize();
  await completion;

  for (const tempPath of tempPathsCleanup) {
    await removePath(tempPath);
  }

  if (!framed) {
    return {
      size: (await fsp.stat(destination)).size,
      index: null,
      lazy: [],
    };
  }
  const hot = await payloadResult!;
  if (lazy.length === 0) {
    return { size: hot.size, index: hot.index, lazy: [] };
  }
  return appendLazyFrames({ input, destination, lazy, hot });
}

// Lazy members go after the hot frames, sorted by path, one entry (with its
// pax/long-name records) per frame, so the stub can skip them on a cold start
// and decode each one on its own later. The footer records every member's
// frame and the sha256 of that frame's compressed bytes.
async function appendLazyFrames({
  input,
  destination,
  lazy,
  hot,
}: {
  input: string;
  destination: string;
  lazy: string[];
  hot: { size: number; index: Buffer | null };
}): Promise<{ size: number; index: Buffer; lazy: LazyMember[] }> {
  const hotFrames = hot.index!.length / indexEntrySize;
  const archive = new TarArchive();
  const result = compressStreamInFrames({
    archive,
    destination,
    params: zstdCompressOptions().params,
    frameSize: zstdFrameBytes(),
    workers: zstdWorkerCount(),
    entryPerFrame: true,
    offsetBase: hot.size,
    hashFrames: true,
  });
  // Unlike the hot stream, a missing lazy member is an error: every member
  // must own exactly one frame.
  archive.on("warning", (warning) => archive.emit("error", warning));
  const members: LazyMember[] = [];
  for (const file of lazy) {
    const absPath = path.join(input, file);
    const name = normalizeArchivePath(file);
    const stats = await fsp.lstat(absPath);
    archive.file(absPath, { name, stats });
    members.push({
      path: name,
      frame: hotFrames + members.length,
      mode: stats.mode & 0o7777,
      size: stats.size,
      sha256: "",
    });
  }
  await archive.finalize();
  const { size, index, hashes } = await result;
  if (hashes.length !== members.length) {
    throw new Error(
      `Expected ${members.length} lazy frames, produced ${hashes.length}.`,
    );
  }
  members.forEach((member, i) => {
    member.sha256 = hashes[i];
  });
  return {
    size: hot.size + size,
    index: Buffer.concat([hot.index!, index]),
    lazy: members,
  };
}

async function appendFile(source: string, destination: string): Promise<void> {
  await stream.pipeline(
    createReadStream(source),
    createWriteStream(destination, { flags: "a" }),
  );
}

// `lazy` is only written when there are lazy members, so other footers stay
// byte-identical to earlier builds. Stubs that predate it ignore the field and
// extract every frame.
function createFooterBuffer({
  identifier,
  command,
  uncompressionMessage,
  compression,
  lazy,
}: {
  identifier: string;
  command: string[];
  uncompressionMessage?: string;
  compression: PayloadCompression;
  lazy: LazyMember[];
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      identifier,
      command,
      uncompressionMessage,
      compression,
      ...(lazy.length > 0 ? { lazy } : {}),
    }),
    "utf8",
  );
}

function createTrailerBuffer({
  payloadOffset,
  payloadSize,
  footerSize,
}: {
  payloadOffset: number;
  payloadSize: number;
  footerSize: number;
}): Buffer {
  const trailer = Buffer.alloc(trailerSize);
  trailer.write(trailerMagic, 0, "utf8");
  trailer.writeBigUInt64LE(BigInt(payloadOffset), 8);
  trailer.writeBigUInt64LE(BigInt(payloadSize), 16);
  trailer.writeBigUInt64LE(BigInt(footerSize), 24);
  return trailer;
}

// v2 adds the frame index location to the trailer.
function createTrailer2Buffer({
  payloadOffset,
  payloadSize,
  footerSize,
  indexOffset,
  indexSize,
}: {
  payloadOffset: number;
  payloadSize: number;
  footerSize: number;
  indexOffset: number;
  indexSize: number;
}): Buffer {
  const trailer = Buffer.alloc(trailer2Size);
  trailer.write(trailerMagic2, 0, "utf8");
  trailer.writeBigUInt64LE(BigInt(payloadOffset), 8);
  trailer.writeBigUInt64LE(BigInt(payloadSize), 16);
  trailer.writeBigUInt64LE(BigInt(footerSize), 24);
  trailer.writeBigUInt64LE(BigInt(indexOffset), 32);
  trailer.writeBigUInt64LE(BigInt(indexSize), 40);
  return trailer;
}

async function buildNativeOutput({
  output,
  force,
  metadataFile,
  identifier,
  command,
  uncompressionMessage,
  compression,
  input,
  components,
  dependencies,
  stub,
  upx,
  upxArgs,
  payloadPath,
  payloadSize,
  payloadIndex,
  lazy,
}: {
  output: string;
  force: boolean;
  metadataFile: string;
  identifier: string;
  command: string[];
  uncompressionMessage?: string;
  compression: PayloadCompression;
  input: string;
  components: Component[];
  dependencies: DependencyGraphEntry[];
  stub: string;
  upx: boolean;
  upxArgs: string[];
  payloadPath: string;
  payloadSize: number;
  payloadIndex: Buffer | null;
  lazy: LazyMember[];
}): Promise<void> {
  await validateOutput(output, force);
  await writeMetadataFile({
    input,
    output,
    metadataFile,
    components,
    dependencies,
  });

  if (!(await pathExists(stub))) {
    throw new Error(
      `Stub not found (your operating system / architecture may be unsupported): ‘${stub}’`,
    );
  }

  await fsp.copyFile(stub, output);
  await fsp.chmod(output, 0o755);
  if (upx) {
    await runUpx(output, normalizeUpxArgs(upxArgs));
  }

  await fsp.appendFile(output, archiveSeparator);
  const payloadOffset = (await fsp.stat(output)).size;
  await appendFile(payloadPath, output);

  const footer = createFooterBuffer({
    identifier,
    command,
    uncompressionMessage,
    compression,
    lazy,
  });
  if (payloadIndex) {
    const indexOffset = payloadOffset + payloadSize;
    await fsp.appendFile(output, payloadIndex);
    await fsp.appendFile(output, footer);
    await fsp.appendFile(
      output,
      createTrailer2Buffer({
        payloadOffset,
        payloadSize,
        footerSize: footer.length,
        indexOffset,
        indexSize: payloadIndex.length,
      }),
    );
  } else {
    await fsp.appendFile(output, footer);
    await fsp.appendFile(
      output,
      createTrailerBuffer({
        payloadOffset,
        payloadSize,
        footerSize: footer.length,
      }),
    );
  }
}

/**
 * Build a `pkg:generic` purl via cdx-purl so the result is guaranteed to satisfy
 * the Package URL spec. Names such as `libstdc++.so.6` need percent-encoding and
 * subpaths must be relative, both of which cdx-purl handles.
 */
function genericPurl({
  namespace,
  name,
  version,
  subpath,
}: {
  namespace?: string;
  name: string;
  version?: string;
  subpath?: string;
}) {
  return build({
    type: "generic",
    namespace: namespace || null,
    name,
    version: version || null,
    // A purl subpath is relative to the package root by definition, so leading
    // slashes, a Windows drive letter (`C:`) and backslashes must all be
    // normalized away. On Windows, `process.report.sharedObjects` reports paths
    // such as `C:\Windows\System32\kernel32.dll`; without this normalization
    // cdx-purl rejects the subpath as absolute (E_INVALID_SUBPATH).
    subpath: subpath
      ? subpath
          .replace(/\\/g, "/")
          .replace(/^[A-Za-z]:[\\/]?/, "")
          .replace(/^\/+/, "")
      : null,
  });
}

/**
 * The build architecture and platform. These used to be emitted as purl
 * qualifiers, but `arch` and `platform` are not valid qualifiers for the
 * `generic` type — only `checksum`, `download_url`, `repository_url` and
 * `vcs_url` are — so they are carried as properties instead.
 */
/**
 * bom-refs are opaque identifiers, and the established convention across cdxgen
 * is the decoded purl — `pkg:generic/@cdxgen/caxa@3.1.0` rather than the
 * percent-encoded `%40cdxgen`. Uniqueness is what matters, and decoding preserves
 * it.
 */
function bomRefFor(purl: string) {
  return decodeURIComponent(purl);
}

function buildTargetProperties() {
  return [
    { name: "cdx:caxa:arch", value: arch() },
    { name: "cdx:caxa:platform", value: platform() },
  ];
}

export function getParentComponent(input: string, output: string) {
  if (!existsSync(path.join(input, "package.json"))) {
    const parentName = path.basename(output).replace(path.extname(output), "");
    const purl = genericPurl({ name: parentName });
    return {
      group: "",
      name: parentName,
      version: undefined,
      purl,
      "bom-ref": bomRefFor(purl),
      properties: buildTargetProperties(),
      type: "application",
    };
  }
  const packageJsonAsString = readFileSync(
    path.join(input, "package.json"),
    "utf-8",
  );
  const packageJson = JSON.parse(packageJsonAsString);
  const name = packageJson.name;
  const version = packageJson.version;
  const author = packageJson.author;
  const authorString =
    author instanceof Object
      ? `${author.name}${author.email ? ` <${author.email}>` : ""}${
          author.url ? ` (${author.url})` : ""
        }`
      : author;
  // Scoped npm names such as `@cdxgen/cdxgen` map onto a purl namespace and name.
  const scopeSeparator = name.startsWith("@") ? name.indexOf("/") : -1;
  const purl = genericPurl({
    namespace: scopeSeparator > -1 ? name.slice(0, scopeSeparator) : undefined,
    name: scopeSeparator > -1 ? name.slice(scopeSeparator + 1) : name,
    version,
  });
  return {
    group: "",
    name,
    version,
    purl,
    "bom-ref": bomRefFor(purl),
    properties: buildTargetProperties(),
    description: packageJson.description,
    license: packageJson.license,
    author: authorString,
    type: "application",
  };
}

/**
 * Get information about the runtime.
 *
 * @returns {Object} Object containing the name and version of the runtime
 */
export function getRuntimeInformation() {
  const runtimeInfo: any = {
    group: undefined,
    name: undefined,
    version: undefined,
    purl: undefined,
    bomRef: undefined,
    scope: "required",
    properties: [
      {
        name: "internal:is_executable",
        value: "true",
      },
    ],
  };
  // @ts-ignore
  if (globalThis.Deno?.version?.deno) {
    runtimeInfo.name = "deno";
    // @ts-ignore
    runtimeInfo.version = globalThis.Deno.version.deno;
    runtimeInfo.purl = genericPurl({
      namespace: "denoland",
      name: runtimeInfo.name,
      version: runtimeInfo.version,
    });
    runtimeInfo["bom-ref"] = runtimeInfo.purl;
    runtimeInfo.cpe = `cpe:2.3:a:deno:deno:${runtimeInfo.version}:*:*:*:-:*:*:*`;
    // @ts-ignore
  } else if (globalThis.Bun?.version) {
    runtimeInfo.name = "bun";
    // @ts-ignore
    runtimeInfo.version = globalThis.Bun.version;
    runtimeInfo.purl = genericPurl({
      namespace: "oven-sh",
      name: runtimeInfo.name,
      version: runtimeInfo.version,
    });
    runtimeInfo["bom-ref"] = runtimeInfo.purl;
  } else if (globalThis.process?.versions?.node) {
    runtimeInfo.name = "node";
    runtimeInfo.version = globalThis.process.versions.node;
    runtimeInfo.purl = genericPurl({
      namespace: "nodejs",
      name: runtimeInfo.name,
      version: runtimeInfo.version,
    });
    runtimeInfo["bom-ref"] = runtimeInfo.purl;
    runtimeInfo.cpe = `cpe:2.3:a:nodejs:node.js:${runtimeInfo.version}:*:*:*:-:*:*:*`;
    const report = process.report.getReport();
    // @ts-ignore
    const nodeSourceUrl = report?.header?.release?.sourceUrl;
    if (nodeSourceUrl) {
      runtimeInfo.externalReferences = [
        {
          url: nodeSourceUrl,
          type: "source-distribution",
          comment: "Node.js release url",
        },
      ];
    }
    // Collect the bundled components in node.js
    // @ts-ignore
    if (report?.header?.componentVersions) {
      const nodeBundledComponents = [];
      for (const [name, version] of Object.entries(
        // @ts-ignore
        report.header.componentVersions,
      )) {
        if (name === "node") {
          continue;
        }
        const apkg = {
          name,
          version,
          description: `Bundled with Node.js ${runtimeInfo.version}`,
          type: "library",
          scope: "excluded",
          purl: genericPurl({ name, version: version as string }),
          "bom-ref": bomRefFor(
            genericPurl({ name, version: version as string }),
          ),
          properties: [
            {
              name: "internal:is_shared_library",
              value: "true",
            },
          ],
        };
        if (nodeSourceUrl) {
          // @ts-ignore
          apkg.externalReferences = [
            {
              url: nodeSourceUrl,
              type: "source-distribution",
              comment: "Node.js release url",
            },
          ];
        }
        nodeBundledComponents.push(apkg);
      }
      if (nodeBundledComponents.length) {
        runtimeInfo.components = nodeBundledComponents;
      }
    }
    // @ts-ignore
    if (report.sharedObjects) {
      const osSharedObjects = [];
      // @ts-ignore
      for (const aso of report.sharedObjects) {
        const name = path.basename(aso);
        if (name === "node") {
          continue;
        }
        // The absolute library path is the only thing distinguishing two shared
        // objects that share a basename, so it belongs in the bom-ref as well as
        // the purl — a duplicated bom-ref would collapse them in the dependency
        // graph.
        const purl = genericPurl({ name, subpath: aso as string });
        const apkg = {
          name,
          type: "library",
          scope: "excluded",
          purl,
          "bom-ref": bomRefFor(purl),
          properties: [
            {
              name: "internal:is_shared_library",
              value: "true",
            },
          ],
        };
        osSharedObjects.push(apkg);
      }
      if (osSharedObjects.length) {
        // Append rather than assign: the bundled-component list built above is
        // also stored here and must not be discarded.
        runtimeInfo.components = [
          ...(runtimeInfo.components ?? []),
          ...osSharedObjects,
        ];
      }
    }
  }
  return runtimeInfo;
}

export async function caxaBatch({
  input,
  targets,
  exclude = defaultExcludes,
  includeNode = true,
  stub = url.fileURLToPath(
    new URL(
      `../stubs/stub--${process.platform}--${process.arch}`,
      import.meta.url,
    ),
  ),
  compression = "zstd",
  payloadFormat,
  lazy = [],
  upx = false,
  upxArgs = [],
  force = true,
}: CommonBuildOptions & {
  targets: TargetOptions[];
  force?: boolean;
}): Promise<void> {
  if (!(await pathExists(input)) || !(await fsp.lstat(input)).isDirectory()) {
    throw new Error(`Input isn’t a directory: ‘${input}’.`);
  }
  if (targets.length === 0) {
    throw new Error("At least one target must be defined.");
  }

  for (const target of targets) {
    if (target.output.endsWith(".app") || target.output.endsWith(".sh")) {
      throw new Error(
        "Batch builds currently support native stub outputs only (not .app or .sh).",
      );
    }
    assertCompressionSupported(target.output, compression);
    resolvePayloadFormat(payloadFormat, target.output);
  }

  const files = await collectFiles(input, exclude);
  const { components, dependencies } = await collectMetadata(
    input,
    files,
    includeNode,
  );
  const batchPayloadFormat = resolvePayloadFormat(
    payloadFormat,
    targets[0].output,
  );
  const lazyFiles = await selectLazyMembers({
    input,
    files,
    patterns: lazy,
    framed: isFramedPayload(compression, batchPayloadFormat),
    output: targets[0].output,
  });

  const payloadPath = createPayloadTempPath(
    path.dirname(targets[0].output),
    compression,
  );
  try {
    await ensureDir(path.dirname(payloadPath));
    const {
      size: payloadSize,
      index: payloadIndex,
      lazy: lazyMembers,
    } = await createPayloadArchive({
      input,
      files,
      destination: payloadPath,
      includeNode,
      compression,
      payloadFormat: batchPayloadFormat,
      upx,
      upxArgs,
      lazy: lazyFiles,
    });

    const contentAddressedIdentifier =
      await createContentAddressedIdentifier(payloadPath);

    for (const target of targets) {
      await buildNativeOutput({
        output: target.output,
        force: target.force ?? force,
        metadataFile: target.metadataFile ?? "binary-metadata.json",
        identifier: target.identifier ?? contentAddressedIdentifier,
        command: target.command,
        uncompressionMessage: target.uncompressionMessage,
        compression,
        input,
        components,
        dependencies,
        stub,
        upx,
        upxArgs,
        payloadPath,
        payloadSize,
        payloadIndex,
        lazy: lazyMembers,
      });
    }
  } finally {
    await removePath(payloadPath);
  }
}

export default async function caxa({
  input,
  output,
  metadataFile = "binary-metadata.json",
  command,
  force = true,
  exclude = defaultExcludes,
  includeNode = true,
  stub = url.fileURLToPath(
    new URL(
      `../stubs/stub--${process.platform}--${process.arch}`,
      import.meta.url,
    ),
  ),
  identifier,
  uncompressionMessage,
  compression = resolveCompressionForOutput(output),
  payloadFormat,
  lazy = [],
  upx = false,
  upxArgs = [],
}: {
  input: string;
  output: string;
  metadataFile: string;
  command: string[];
  force?: boolean;
  exclude?: string[];
  filter?: unknown;
  includeNode?: boolean;
  stub?: string;
  identifier?: string;
  removeBuildDirectory?: boolean;
  uncompressionMessage?: string;
  compression?: PayloadCompression;
  payloadFormat?: PayloadFormat;
  lazy?: string[];
  upx?: boolean;
  upxArgs?: string[];
}): Promise<void> {
  if (!(await pathExists(input)) || !(await fsp.lstat(input)).isDirectory())
    throw new Error(`Input isn’t a directory: ‘${input}’.`);

  if (!exclude) exclude = defaultExcludes;
  const files = await collectFiles(input, exclude);
  const { components, dependencies } = await collectMetadata(
    input,
    files,
    includeNode,
  );

  assertCompressionSupported(output, compression);
  // Fails early when v2 is requested for .app or .sh outputs.
  const payloadFormatForOutput = resolvePayloadFormat(payloadFormat, output);
  // .app and .sh outputs use v1, so --lazy fails here for them too.
  const lazyFiles = await selectLazyMembers({
    input,
    files,
    patterns: lazy,
    framed:
      !output.endsWith(".app") &&
      !output.endsWith(".sh") &&
      isFramedPayload(compression, payloadFormatForOutput),
    output,
  });

  if (output.endsWith(".app")) {
    await validateOutput(output, force);
    await writeMetadataFile({
      input,
      output,
      metadataFile,
      components,
      dependencies,
    });

    if (process.platform !== "darwin")
      throw new Error(
        "macOS Application Bundles (.app) are supported in macOS only.",
      );

    await ensureDir(path.join(output, "Contents", "MacOS"));
    await ensureDir(path.join(output, "Contents", "Resources"));

    const name = path.basename(output, ".app");

    await fsp.writeFile(
      path.join(output, "Contents", "MacOS", name),
      stripIndent`
        #!/usr/bin/env sh
        open "$(dirname "$0")/../Resources/${name}"
      ` + "\n",
      { mode: 0o755 },
    );

    await fsp.writeFile(
      path.join(output, "Contents", "Resources", name),
      stripIndent`
        #!/usr/bin/env sh
        ${command
          .map(
            (p) =>
              `"${p.replace(/\{\{\s*caxa\s*}}/g, `$(dirname "$0")/application`)}"`,
          )
          .join(" ")}
      ` + "\n",
      { mode: 0o755 },
    );

    const appDest = path.join(output, "Contents", "Resources", "application");
    await ensureDir(appDest);

    for (const file of files) {
      const src = path.join(input, file);
      const dest = path.join(appDest, file);
      await copyEntry(src, dest);
    }

    if (includeNode) {
      const bundle = await preparePortableNodeBundle({
        stagingParent: path.dirname(output),
        upx,
        upxArgs,
      });
      try {
        await copyDirectoryContents(bundle.root, appDest);
      } finally {
        await removePath(bundle.root);
      }
    }
  } else if (output.endsWith(".sh")) {
    await validateOutput(output, force);
    await writeMetadataFile({
      input,
      output,
      metadataFile,
      components,
      dependencies,
    });

    if (process.platform === "win32")
      throw new Error("The Shell Stub (.sh) isn’t supported in Windows.");

    const payloadPath = createPayloadTempPath(
      path.dirname(output),
      compression,
    );
    try {
      await createPayloadArchive({
        input,
        files,
        destination: payloadPath,
        includeNode,
        compression,
        payloadFormat: payloadFormatForOutput,
        upx,
        upxArgs,
      });
      if (!identifier) {
        identifier = await createContentAddressedIdentifier(payloadPath);
      }

      let shellStub =
        stripIndent`
        #!/usr/bin/env sh
        export CAXA_TMP="$(dirname $(mktemp))/caxa"
        export CAXA_ID="${identifier}"
        while true
        do
          export CAXA_LOCK="$CAXA_TMP/locks/$CAXA_ID"
          export CAXA_APP="$CAXA_TMP/apps/$CAXA_ID"
          if [ -d "$CAXA_APP" ] && [ ! -d "$CAXA_LOCK" ]; then
             break
          fi
          
          ${uncompressionMessage ? `echo "${uncompressionMessage}" >&2` : ""}
          mkdir -p "$CAXA_LOCK" "$CAXA_APP"
          tail -n+{{lines}} "$0" | tar -xz -C "$CAXA_APP"
          rmdir "$CAXA_LOCK"
          break
        done
        exec ${command
          .map((p) => `"${p.replace(/\{\{\s*caxa\s*}}/g, `"$CAXA_APP"`)}"`)
          .join(" ")} "$@"
      ` + "\n";

      shellStub = shellStub.replace(
        "{{lines}}",
        String(shellStub.split("\n").length),
      );
      await fsp.writeFile(output, shellStub, { mode: 0o755 });
      await appendFile(payloadPath, output);
    } finally {
      await removePath(payloadPath);
    }
  } else {
    const payloadPath = createPayloadTempPath(
      path.dirname(output),
      compression,
    );
    try {
      const {
        size: payloadSize,
        index: payloadIndex,
        lazy: lazyMembers,
      } = await createPayloadArchive({
        input,
        files,
        destination: payloadPath,
        includeNode,
        compression,
        payloadFormat: payloadFormatForOutput,
        upx,
        upxArgs,
        lazy: lazyFiles,
      });
      if (!identifier) {
        identifier = await createContentAddressedIdentifier(payloadPath);
      }
      await buildNativeOutput({
        output,
        force,
        metadataFile,
        identifier,
        command,
        uncompressionMessage,
        compression,
        input,
        components,
        dependencies,
        stub,
        upx,
        upxArgs,
        payloadPath,
        payloadSize,
        payloadIndex,
        lazy: lazyMembers,
      });
    } finally {
      await removePath(payloadPath);
    }
  }
}

if (
  url.fileURLToPath(import.meta.url) === (await fsp.realpath(process.argv[1]))
) {
  const version = JSON.parse(
    await fsp.readFile(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  const helpText = createCliHelpText(version);

  try {
    const parsedArguments = parseCliArguments(process.argv.slice(2));

    if (parsedArguments.showHelp) {
      console.log(helpText);
      process.exit(0);
    }

    if (parsedArguments.showVersion) {
      console.log(version);
      process.exit(0);
    }

    if (!parsedArguments.options.input) {
      throw new Error("Missing required option ‘--input’.\n");
    }

    if (parsedArguments.options.targetsFile) {
      if (
        parsedArguments.options.output ||
        parsedArguments.command.length > 0
      ) {
        throw new Error(
          "Use either --targets-file or --output with a command, not both.",
        );
      }

      const targets = await readJsonFile(parsedArguments.options.targetsFile);
      if (!Array.isArray(targets)) {
        throw new Error("Targets file must contain a JSON array.");
      }

      await caxaBatch({
        input: parsedArguments.options.input,
        exclude: parsedArguments.options.exclude,
        includeNode: parsedArguments.options.includeNode,
        stub: parsedArguments.options.stub,
        compression: parsedArguments.options.compression,
        payloadFormat: parsedArguments.options.payloadFormat,
        lazy: parsedArguments.options.lazy,
        upx: parsedArguments.options.upx,
        upxArgs: parsedArguments.options.upxArgs,
        force: parsedArguments.options.force,
        targets,
      });
      process.exit(0);
    }

    if (!parsedArguments.options.output) {
      throw new Error("Missing required option ‘--output’.\n");
    }
    if (parsedArguments.command.length === 0) {
      throw new Error("Missing required argument ‘command’.\n");
    }

    await caxa({
      ...parsedArguments.options,
      input: parsedArguments.options.input,
      output: parsedArguments.options.output,
      command: parsedArguments.command,
    });
  } catch (error: any) {
    console.error(error.message);
    console.error();
    console.error(helpText);
    process.exit(1);
  }
}
