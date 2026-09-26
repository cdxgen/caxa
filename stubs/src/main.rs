//! caxa runtime stub: locates the payload appended to this executable,
//! extracts it once into a cache directory and execs the configured command.
//!
//! Binary layout:
//!   [stub]["\nCAXACAXACAXA\n"][payload][JSON footer][32-byte trailer]
//! Trailer v1: "CAXAIDX1" + LE u64 payload offset, payload size, footer size.
//! Binaries without a trailer fall back to the legacy separator scan.
//!
//! Payload format v2 (CAXAIDX2) stores the payload as independent zstd frames
//! that each hold whole tar entries, so the stub can decode and extract frames
//! in parallel:
//!   [stub][separator][payload: N concatenated zstd frames][frame index]
//!   [JSON footer][48-byte trailer]
//! Trailer v2: "CAXAIDX2" + LE u64 payload offset, payload size, footer size,
//! index offset, index size. The index is `count` LE u64 triples of compressed
//! offset (relative to the payload start), compressed size and uncompressed
//! size; frames are contiguous and cover the payload exactly.
//!
//! Lazy members (footer `lazy`) are executables packed one per frame at the
//! end of a v2 payload. On Unix a cold start skips their frames and writes a
//! placeholder at each member path instead: a copy of this stub (the bytes
//! before the separator) followed by
//!   [placeholder JSON][LE u64 JSON length]["CAXALZY1"]
//! The first run of a placeholder finds the caxa binary (CAXA_EXECUTABLE, then
//! the recorded path), verifies and decodes the member's frame, renames the
//! member over the placeholder and execs it. On Windows a running exe cannot
//! be replaced, so lazy frames are extracted eagerly and no placeholder is
//! written.

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Cursor, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{self, Command};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_BUFFER_SIZE: u64 = 1024 * 1024;
const ARCHIVE_SEPARATOR: &[u8] = b"\nCAXACAXACAXA\n";
const TRAILER_MAGIC: &[u8] = b"CAXAIDX1";
const TRAILER_SIZE: u64 = 32;
const TRAILER2_MAGIC: &[u8] = b"CAXAIDX2";
const TRAILER2_SIZE: u64 = 48;
const INDEX_ENTRY_SIZE: u64 = 24;
const PLACEHOLDER_MAGIC: &[u8] = b"CAXALZY1";
const PLACEHOLDER_TRAILER_SIZE: u64 = 16;

// Limits for hostile v2 trailers/indexes: a frame index of the maximum frame
// count is 1.5 MB, and real footers are a few hundred JSON bytes.
const MAX_FRAMES: u64 = 65536;
const MAX_FRAME_UNCOMPRESSED: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED: u64 = 64 * 1024 * 1024 * 1024;
const MAX_FOOTER_SIZE: u64 = 1024 * 1024;
// Limits for hostile placeholders. A frame compressed with zstd is at most
// its input plus a small bound (ZSTD_compressBound), and a stub copy is a few
// hundred KB to a few MB.
const MAX_PLACEHOLDER_JSON: u64 = 64 * 1024;
const MAX_FRAME_COMPRESSED: u64 = MAX_FRAME_UNCOMPRESSED + (MAX_FRAME_UNCOMPRESSED >> 7) + 128 * 1024;
const MAX_STUB_SIZE: u64 = 64 * 1024 * 1024;
/// Cap on live uncompressed frame bytes while extracting; frames bigger than
/// the budget (large single tar entries) lower the concurrency instead.
const FRAME_MEMORY_BUDGET: u64 = if cfg!(target_pointer_width = "64") {
    1024 * 1024 * 1024
} else {
    256 * 1024 * 1024
};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default)]
    identifier: String,
    #[serde(default)]
    command: Vec<String>,
    #[serde(default)]
    uncompression_message: String,
    #[serde(default)]
    compression: String,
    #[serde(default)]
    lazy: Vec<LazyMember>,
}

/// A footer `lazy` entry: an executable in its own frame, materialized on
/// first use. `sha256` is over the frame's compressed bytes.
#[derive(Debug, Clone, Deserialize)]
struct LazyMember {
    path: String,
    frame: u64,
    mode: u32,
    size: u64,
    sha256: String,
}

/// The JSON a placeholder carries: enough to find, verify and decode its
/// member's frame in the caxa binary. `offset` is relative to the payload
/// start, so the same payload behind a different stub still resolves.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Placeholder {
    identifier: String,
    path: String,
    frame: u64,
    offset: u64,
    compressed_size: u64,
    uncompressed_size: u64,
    sha256: String,
    mode: u32,
    size: u64,
    /// Absolute path of the binary that wrote the placeholder, as a hint.
    source: String,
}

/// One v2 frame: a slice of the payload that decodes to whole tar entries.
#[derive(Debug)]
struct FrameEntry {
    compressed_offset: u64,
    compressed_size: u64,
    uncompressed_size: u64,
}

struct Layout {
    config: Config,
    payload_offset: u64,
    payload_size: u64,
    /// Only populated for legacy (trailer-less) binaries.
    payload: Option<Vec<u8>>,
    /// Only populated for v2 (CAXAIDX2) payloads.
    frames: Vec<FrameEntry>,
}

type Result<T> = std::result::Result<T, String>;

fn main() {
    let exe = env::current_exe().unwrap_or_else(|e| fatal(&format!("failed to find executable: {e}")));
    // A placeholder is checked for first, so it never reaches the legacy
    // separator scan (its stub bytes contain the separator constant).
    match read_self_placeholder(&exe) {
        Ok(Some(placeholder)) => run_placeholder(&exe, placeholder),
        Ok(None) => {}
        Err(e) => fatal(&format!("invalid lazy placeholder {}: {e}", exe.display())),
    }
    let layout = match inspect_binary(&exe) {
        Ok(layout) => layout,
        Err(e) => {
            exec_if_replaced(&exe);
            fatal(&format!("binary corrupted: {e}"))
        }
    };
    let app_dir =
        prepare_application(&exe, &layout).unwrap_or_else(|e| fatal(&format!("failed to prepare application: {e}")));
    let code = run(&layout.config, &exe, &app_dir).unwrap_or_else(|e| fatal(&format!("execution failed: {e}")));
    process::exit(code);
}

fn fatal(msg: &str) -> ! {
    eprintln!("caxa: {msg}");
    process::exit(1);
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).rposition(|w| w == needle)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Legacy layout: [stub][separator][payload]["\n"][footer json]
fn parse_binary(data: &[u8]) -> Result<(Config, usize, usize)> {
    let footer_idx = rfind(data, b"\n").ok_or("footer not found")?;
    let config: Config =
        serde_json::from_slice(&data[footer_idx + 1..]).map_err(|e| format!("invalid footer json: {e}"))?;
    let archive_idx = find(data, ARCHIVE_SEPARATOR).ok_or("archive separator not found")?;
    let start = archive_idx + ARCHIVE_SEPARATOR.len();
    if start > footer_idx {
        return Err("archive separator after footer".into());
    }
    Ok((config, start, footer_idx))
}

/// Parse and validate the v2 frame index. Frames must be contiguous, cover the
/// payload exactly and stay within the declared bounds, so a corrupt or
/// hostile index fails here instead of during extraction.
fn read_index(file: &mut File, index_offset: u64, index_size: u64, payload_size: u64) -> Result<Vec<FrameEntry>> {
    if index_size == 0 || index_size % INDEX_ENTRY_SIZE != 0 {
        return Err("invalid frame index size".into());
    }
    let count = index_size / INDEX_ENTRY_SIZE;
    if count > MAX_FRAMES {
        return Err("too many frames".into());
    }
    let mut raw = vec![0u8; index_size as usize];
    file.seek(SeekFrom::Start(index_offset))
        .and_then(|_| file.read_exact(&mut raw))
        .map_err(|e| format!("failed to read frame index: {e}"))?;

    let mut frames = Vec::with_capacity(count as usize);
    let mut expected_offset = 0u64;
    let mut total_uncompressed = 0u64;
    for entry in raw.chunks_exact(INDEX_ENTRY_SIZE as usize) {
        let le = |r: std::ops::Range<usize>| u64::from_le_bytes(entry[r].try_into().unwrap());
        let (compressed_offset, compressed_size, uncompressed_size) = (le(0..8), le(8..16), le(16..24));
        if compressed_size == 0 || uncompressed_size == 0 {
            return Err("empty frame".into());
        }
        if compressed_offset != expected_offset {
            return Err("frames are not contiguous".into());
        }
        let end = compressed_offset
            .checked_add(compressed_size)
            .ok_or("frame size overflow")?;
        if end > payload_size {
            return Err("frame outside payload".into());
        }
        if uncompressed_size > MAX_FRAME_UNCOMPRESSED {
            return Err("frame too large".into());
        }
        total_uncompressed = total_uncompressed
            .checked_add(uncompressed_size)
            .ok_or("total uncompressed size overflow")?;
        if total_uncompressed > MAX_TOTAL_UNCOMPRESSED {
            return Err("total uncompressed size too large".into());
        }
        expected_offset = end;
        frames.push(FrameEntry {
            compressed_offset,
            compressed_size,
            uncompressed_size,
        });
    }
    if expected_offset != payload_size {
        return Err("frame index does not cover the payload".into());
    }
    Ok(frames)
}

fn read_footer(file: &mut File, footer_offset: u64, footer_size: u64) -> Result<Config> {
    if footer_size > MAX_FOOTER_SIZE {
        return Err("footer too large".into());
    }
    let mut footer = vec![0u8; footer_size as usize];
    file.seek(SeekFrom::Start(footer_offset))
        .and_then(|_| file.read_exact(&mut footer))
        .map_err(|e| format!("failed to read footer: {e}"))?;
    serde_json::from_slice(&footer).map_err(|e| format!("invalid footer json: {e}"))
}

fn inspect_binary(exe: &Path) -> Result<Layout> {
    let mut file = File::open(exe).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();

    // The magic is the first field of both trailers.
    let magic_at = |file: &mut File, at: u64| -> Result<[u8; 8]> {
        let mut magic = [0u8; 8];
        file.seek(SeekFrom::Start(at))
            .and_then(|_| file.read_exact(&mut magic))
            .map_err(|e| e.to_string())?;
        Ok(magic)
    };
    let le = |bytes: &[u8]| u64::from_le_bytes(bytes.try_into().unwrap());

    if size >= TRAILER2_SIZE && magic_at(&mut file, size - TRAILER2_SIZE)? == *TRAILER2_MAGIC {
        let mut trailer = [0u8; TRAILER2_SIZE as usize];
        file.seek(SeekFrom::Start(size - TRAILER2_SIZE))
            .and_then(|_| file.read_exact(&mut trailer))
            .map_err(|e| e.to_string())?;
        let (payload_offset, payload_size, footer_size, index_offset, index_size) = (
            le(&trailer[8..16]),
            le(&trailer[16..24]),
            le(&trailer[24..32]),
            le(&trailer[32..40]),
            le(&trailer[40..48]),
        );
        let footer_offset = size
            .checked_sub(TRAILER2_SIZE)
            .and_then(|s| s.checked_sub(footer_size))
            .ok_or("invalid trailer offsets")?;
        let index_end = index_offset.checked_add(index_size).ok_or("invalid index offsets")?;
        if index_end > footer_offset {
            return Err("index overlaps footer".into());
        }
        if payload_offset
            .checked_add(payload_size)
            .map_or(true, |end| end > index_offset)
        {
            return Err("payload overlaps index".into());
        }
        let config = read_footer(&mut file, footer_offset, footer_size)?;
        if config.compression != "zstd" {
            return Err(format!("v2 payload requires zstd, not '{}'", config.compression));
        }
        let frames = read_index(&mut file, index_offset, index_size, payload_size)?;
        validate_lazy(&config.lazy, &frames)?;
        return Ok(Layout {
            config,
            payload_offset,
            payload_size,
            payload: None,
            frames,
        });
    }

    if size >= TRAILER_SIZE && magic_at(&mut file, size - TRAILER_SIZE)? == *TRAILER_MAGIC {
        let mut trailer = [0u8; TRAILER_SIZE as usize];
        file.seek(SeekFrom::Start(size - TRAILER_SIZE))
            .and_then(|_| file.read_exact(&mut trailer))
            .map_err(|e| e.to_string())?;
        let (payload_offset, payload_size, footer_size) =
            (le(&trailer[8..16]), le(&trailer[16..24]), le(&trailer[24..32]));
        let footer_offset = size
            .checked_sub(TRAILER_SIZE)
            .and_then(|s| s.checked_sub(footer_size))
            .ok_or("invalid trailer offsets")?;
        if payload_offset
            .checked_add(payload_size)
            .map_or(true, |end| end > footer_offset)
        {
            return Err("payload overlaps footer".into());
        }
        let config = read_footer(&mut file, footer_offset, footer_size)?;
        return Ok(Layout {
            config,
            payload_offset,
            payload_size,
            payload: None,
            frames: Vec::new(),
        });
    }

    let data = fs::read(exe).map_err(|e| e.to_string())?;
    let (config, start, end) = parse_binary(&data)?;
    Ok(Layout {
        config,
        payload_offset: start as u64,
        payload_size: (end - start) as u64,
        payload: Some(data[start..end].to_vec()),
        frames: Vec::new(),
    })
}

fn temp_root() -> PathBuf {
    match env::var_os("CAXA_TEMP_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => env::temp_dir().join("caxa"),
    }
}

/// Directory protocol (unchanged from caxa 3, so existing caches stay valid):
/// apps/<id>/<attempt> is valid when locks/<id>/<attempt> does not exist.
fn prepare_application(exe: &Path, layout: &Layout) -> Result<PathBuf> {
    let root = temp_root();
    let id = &layout.config.identifier;
    for attempt in 0u32.. {
        let app_dir = root.join("apps").join(id).join(attempt.to_string());
        let lock_dir = root.join("locks").join(id).join(attempt.to_string());

        if app_dir.is_dir() {
            if !lock_dir.exists() {
                return Ok(app_dir);
            }
            continue;
        }

        fs::create_dir_all(&lock_dir).map_err(|e| format!("failed to create lock: {e}"))?;

        let done = Arc::new(AtomicBool::new(false));
        let ticker = (!layout.config.uncompression_message.is_empty()).then(|| {
            eprint!("{}", layout.config.uncompression_message);
            let done = done.clone();
            thread::spawn(move || {
                let mut waited = 0u64;
                while !done.load(Ordering::Relaxed) {
                    thread::sleep(Duration::from_millis(100));
                    waited += 100;
                    if waited % 2000 == 0 {
                        eprint!(".");
                    }
                }
                eprintln!();
            })
        });

        let result = extract(layout, exe, &app_dir);
        done.store(true, Ordering::Relaxed);
        if let Some(t) = ticker {
            let _ = t.join();
        }
        if let Err(e) = result {
            let _ = fs::remove_dir_all(&app_dir);
            let _ = fs::remove_dir_all(&lock_dir);
            return Err(e);
        }
        let _ = fs::remove_dir_all(&lock_dir);
        return Ok(app_dir);
    }
    unreachable!()
}

fn decompressor<'a>(compression: &str, input: Box<dyn Read + 'a>) -> Result<Box<dyn Read + 'a>> {
    match compression {
        "" | "gzip" => Ok(Box::new(flate2::read::GzDecoder::new(input))),
        "zstd" => zstd_reader(input),
        other => Err(format!("unsupported payload compression: {other}")),
    }
}

fn zstd_reader<'a>(input: Box<dyn Read + 'a>) -> Result<Box<dyn Read + 'a>> {
    let mut d = zstd::stream::read::Decoder::new(input).map_err(|e| e.to_string())?;
    d.window_log_max(window_log_max()).map_err(|e| e.to_string())?;
    Ok(Box::new(d))
}

/// Reject absolute paths and `..` so entries cannot escape `dest`.
fn safe_join(dest: &Path, name: &Path) -> Result<PathBuf> {
    let mut out = dest.to_path_buf();
    for c in name.components() {
        match c {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            _ => return Err(format!("illegal file path: {}", name.display())),
        }
    }
    Ok(out)
}

struct Job {
    dest: PathBuf,
    data: Vec<u8>,
    mode: u32,
}

/// Directory creation shared by the reader thread and the writer pool.
#[derive(Clone, Default)]
struct DirCache(Arc<Mutex<std::collections::HashSet<PathBuf>>>);

impl DirCache {
    fn ensure(&self, dir: &Path) -> io::Result<()> {
        if self.0.lock().unwrap().contains(dir) {
            return Ok(());
        }
        fs::create_dir_all(dir)?;
        self.0.lock().unwrap().insert(dir.to_path_buf());
        Ok(())
    }
}

fn write_file(path: &Path, data: &[u8], mode: u32) -> io::Result<()> {
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    opts.open(path)?.write_all(data)
}

fn extract(layout: &Layout, exe: &Path, dest: &Path) -> Result<()> {
    if !layout.frames.is_empty() {
        return extract_frames(layout, exe, dest);
    }
    let input: Box<dyn Read> = match &layout.payload {
        Some(p) => Box::new(io::Cursor::new(p.as_slice())),
        None => {
            let mut f = File::open(exe).map_err(|e| e.to_string())?;
            f.seek(SeekFrom::Start(layout.payload_offset))
                .map_err(|e| e.to_string())?;
            Box::new(BufReader::with_capacity(256 * 1024, f.take(layout.payload_size)))
        }
    };
    extract_from(decompressor(&layout.config.compression, input)?, dest)
}

fn window_log_max() -> u32 {
    // Payloads are built with long-distance matching; allow the largest window
    // libzstd supports (ZSTD_WINDOWLOG_MAX: 31 on 64-bit, 30 on 32-bit).
    if cfg!(target_pointer_width = "64") {
        31
    } else {
        30
    }
}

/// Decode every eager frame and extract its entries in parallel. Concurrency
/// is capped so that the live uncompressed frame bytes stay within
/// FRAME_MEMORY_BUDGET; frames larger than the budget (big single tar entries)
/// lower the thread count instead of the memory cap.
///
/// Frames are handed out largest first (longest-processing-time scheduling,
/// ties by index), so a big frame late in the payload cannot become the tail of
/// the whole extraction. The payload order is unchanged.
fn extract_frames(layout: &Layout, exe: &Path, dest: &Path) -> Result<()> {
    let frames = &layout.frames;
    let lazy = lazy_members(&layout.config);
    let order = eager_order(frames, lazy);
    let biggest = order.first().map_or(0, |&i| frames[i].uncompressed_size);
    let cpus = thread::available_parallelism().map_or(2, |n| n.get()) as u64;
    let workers = (FRAME_MEMORY_BUDGET / biggest.max(1))
        .clamp(1, cpus)
        .min(order.len() as u64) as usize;

    let order = &order;
    let next = &AtomicUsize::new(0);
    let failure = &Mutex::new(None::<String>);
    let dirs = &DirCache::default();
    thread::scope(|scope| {
        for _ in 0..workers {
            let mut file = match File::open(exe) {
                Ok(f) => f,
                Err(e) => {
                    failure.lock().unwrap().get_or_insert(e.to_string());
                    break;
                }
            };
            scope.spawn(move || loop {
                if failure.lock().unwrap().is_some() {
                    return;
                }
                let n = next.fetch_add(1, Ordering::Relaxed);
                let Some(&i) = order.get(n) else {
                    return;
                };
                if let Err(e) = extract_frame(&mut file, layout.payload_offset, &frames[i], dest, dirs) {
                    failure.lock().unwrap().get_or_insert(e);
                    return;
                }
            });
        }
    });
    let failed = failure.lock().unwrap().take();
    if let Some(e) = failed {
        return Err(e);
    }
    write_placeholders(layout, lazy, exe, dest, dirs)
}

/// Indexes of the frames to extract now, largest uncompressed size first,
/// ties broken by index.
fn eager_order(frames: &[FrameEntry], lazy: &[LazyMember]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..frames.len())
        .filter(|i| !lazy.iter().any(|m| m.frame == *i as u64))
        .collect();
    order.sort_by_key(|&i| (std::cmp::Reverse(frames[i].uncompressed_size), i));
    order
}

/// The lazy members this platform honours. Windows cannot replace a running
/// exe in place, so there every frame is extracted eagerly.
fn lazy_members(config: &Config) -> &[LazyMember] {
    if cfg!(windows) {
        &[]
    } else {
        &config.lazy
    }
}

/// Footer `lazy` entries must name distinct frames of this payload and safe
/// relative paths; anything else is a corrupt binary.
fn validate_lazy(lazy: &[LazyMember], frames: &[FrameEntry]) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for member in lazy {
        let frame = usize::try_from(member.frame)
            .ok()
            .and_then(|i| frames.get(i))
            .ok_or_else(|| format!("lazy member {} names a missing frame", member.path))?;
        if !seen.insert(member.frame) {
            return Err(format!("lazy member {} shares frame {}", member.path, member.frame));
        }
        check_member_path(&member.path)?;
        check_sha256(&member.sha256)?;
        if member.size > frame.uncompressed_size {
            return Err(format!("lazy member {} is larger than its frame", member.path));
        }
    }
    Ok(())
}

fn check_member_path(path: &str) -> Result<()> {
    let p = Path::new(path);
    if path.is_empty() || !p.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("illegal lazy member path: {path}"));
    }
    Ok(())
}

fn check_sha256(hex: &str) -> Result<()> {
    if hex.len() != 64 || !hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return Err("invalid sha256".into());
    }
    Ok(())
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// Write one placeholder per lazy member: this binary's stub bytes plus a
/// placeholder trailer, with the member's mode.
fn write_placeholders(layout: &Layout, lazy: &[LazyMember], exe: &Path, dest: &Path, dirs: &DirCache) -> Result<()> {
    if lazy.is_empty() {
        return Ok(());
    }
    let stub = read_stub_bytes(exe, layout.payload_offset)?;
    let source = fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    for member in lazy {
        let frame = &layout.frames[member.frame as usize];
        let placeholder = Placeholder {
            identifier: layout.config.identifier.clone(),
            path: member.path.clone(),
            frame: member.frame,
            offset: frame.compressed_offset,
            compressed_size: frame.compressed_size,
            uncompressed_size: frame.uncompressed_size,
            sha256: member.sha256.clone(),
            mode: member.mode,
            size: member.size,
            source: source.to_string_lossy().into_owned(),
        };
        let json = serde_json::to_vec(&placeholder).map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(stub.len() + json.len() + PLACEHOLDER_TRAILER_SIZE as usize);
        bytes.extend_from_slice(&stub);
        bytes.extend_from_slice(&json);
        bytes.extend_from_slice(&(json.len() as u64).to_le_bytes());
        bytes.extend_from_slice(PLACEHOLDER_MAGIC);
        let target = safe_join(dest, Path::new(&member.path))?;
        if let Some(p) = target.parent() {
            dirs.ensure(p).map_err(|e| e.to_string())?;
        }
        write_file(&target, &bytes, member.mode).map_err(|e| format!("failed to write placeholder: {e}"))?;
    }
    Ok(())
}

/// The stub is everything before the separator that precedes the payload.
fn read_stub_bytes(exe: &Path, payload_offset: u64) -> Result<Vec<u8>> {
    let sep = ARCHIVE_SEPARATOR.len() as u64;
    let stub_len = payload_offset
        .checked_sub(sep)
        .filter(|n| *n > 0 && *n <= MAX_STUB_SIZE)
        .ok_or("invalid stub size")?;
    let mut bytes = vec![0u8; payload_offset as usize];
    let mut file = File::open(exe).map_err(|e| e.to_string())?;
    file.read_exact(&mut bytes)
        .map_err(|e| format!("failed to read stub: {e}"))?;
    if &bytes[stub_len as usize..] != ARCHIVE_SEPARATOR {
        return Err("separator not found before the payload".into());
    }
    bytes.truncate(stub_len as usize);
    Ok(bytes)
}

/// Parse a placeholder trailer. Ok(None) when the file has no placeholder
/// magic; every other defect is an error, and every size is bounded before
/// anything is allocated.
fn read_placeholder(file: &mut File) -> Result<Option<Placeholder>> {
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let magic_len = PLACEHOLDER_MAGIC.len() as u64;
    if size < magic_len {
        return Ok(None);
    }
    let mut magic = [0u8; 8];
    file.seek(SeekFrom::Start(size - magic_len))
        .and_then(|_| file.read_exact(&mut magic))
        .map_err(|e| e.to_string())?;
    if magic != *PLACEHOLDER_MAGIC {
        return Ok(None);
    }
    if size < PLACEHOLDER_TRAILER_SIZE {
        return Err("truncated placeholder trailer".into());
    }
    let mut len = [0u8; 8];
    file.seek(SeekFrom::Start(size - PLACEHOLDER_TRAILER_SIZE))
        .and_then(|_| file.read_exact(&mut len))
        .map_err(|e| e.to_string())?;
    let json_len = u64::from_le_bytes(len);
    if json_len == 0 || json_len > MAX_PLACEHOLDER_JSON || json_len > size - PLACEHOLDER_TRAILER_SIZE {
        return Err("placeholder JSON length out of bounds".into());
    }
    let mut json = vec![0u8; json_len as usize];
    file.seek(SeekFrom::Start(size - PLACEHOLDER_TRAILER_SIZE - json_len))
        .and_then(|_| file.read_exact(&mut json))
        .map_err(|e| e.to_string())?;
    let placeholder: Placeholder =
        serde_json::from_slice(&json).map_err(|e| format!("invalid placeholder json: {e}"))?;
    validate_placeholder(&placeholder)?;
    Ok(Some(placeholder))
}

fn validate_placeholder(p: &Placeholder) -> Result<()> {
    if p.identifier.is_empty() {
        return Err("placeholder without identifier".into());
    }
    check_member_path(&p.path)?;
    check_sha256(&p.sha256)?;
    if p.compressed_size == 0 || p.compressed_size > MAX_FRAME_COMPRESSED {
        return Err("placeholder compressed size out of bounds".into());
    }
    if p.uncompressed_size == 0 || p.uncompressed_size > MAX_FRAME_UNCOMPRESSED {
        return Err("placeholder uncompressed size out of bounds".into());
    }
    if p.size > p.uncompressed_size {
        return Err("placeholder member size out of bounds".into());
    }
    Ok(())
}

/// Read this process's own placeholder trailer. On Linux /proc/self/exe is the
/// running file even after a concurrent materialization renamed the member
/// over its path.
fn read_self_placeholder(exe: &Path) -> Result<Option<Placeholder>> {
    let own = if cfg!(target_os = "linux") {
        File::open("/proc/self/exe").or_else(|_| File::open(exe))
    } else {
        File::open(exe)
    };
    let mut file = own.map_err(|e| e.to_string())?;
    read_placeholder(&mut file)
}

/// Where the running placeholder lives. The path must end with the member
/// path, so a materialization only ever replaces the member's own file.
fn placeholder_target(exe: &Path, member: &str) -> Result<PathBuf> {
    let mut path = exe.to_path_buf();
    // Linux reports a renamed-over executable as "<path> (deleted)".
    if cfg!(target_os = "linux") && !path.exists() {
        if let Some(stripped) = path.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
            path = PathBuf::from(stripped);
        }
    }
    let path = fs::canonicalize(&path).map_err(|e| format!("cannot resolve {}: {e}", path.display()))?;
    if !path.ends_with(member) {
        return Err(format!("{} is not at its member path", path.display()));
    }
    Ok(path)
}

/// Materialize the member behind a running placeholder and exec it with the
/// original argv (argv[0] included) and environment. Never returns.
fn run_placeholder(exe: &Path, placeholder: Placeholder) -> ! {
    let target = placeholder_target(exe, &placeholder.path);
    let result = target.clone().and_then(|target| {
        let data = materialize_member(&placeholder)?;
        install_member(&target, &data.0[data.1.clone()], placeholder.mode)?;
        Ok(target)
    });
    match result {
        Ok(target) => {
            let err = exec_path(&target);
            fatal(&format!("failed to exec {}: {err}", target.display()))
        }
        Err(e) => {
            let id_dir = target
                .ok()
                .and_then(|t| strip_member(&t, &placeholder.path))
                .and_then(|app| app.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| temp_root().join("apps").join(&placeholder.identifier));
            fatal(&format!(
                "lazy member '{}' of '{}' is unavailable: {e}; run the caxa binary again, or delete {}",
                placeholder.path,
                placeholder.identifier,
                id_dir.display()
            ))
        }
    }
}

fn strip_member(target: &Path, member: &str) -> Option<PathBuf> {
    let mut app = target.to_path_buf();
    for _ in Path::new(member).components() {
        app = app.parent()?.to_path_buf();
    }
    Some(app)
}

/// Find a source binary for the placeholder (CAXA_EXECUTABLE first, then the
/// recorded path) and return its verified, decoded frame plus the byte range
/// of the member's content inside it.
fn materialize_member(p: &Placeholder) -> Result<(Vec<u8>, std::ops::Range<usize>)> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(v) = env::var_os("CAXA_EXECUTABLE").filter(|v| !v.is_empty()) {
        candidates.push(PathBuf::from(v));
    }
    if !p.source.is_empty() {
        candidates.push(PathBuf::from(&p.source));
    }
    materialize_from(&candidates, p)
}

fn materialize_from(candidates: &[PathBuf], p: &Placeholder) -> Result<(Vec<u8>, std::ops::Range<usize>)> {
    let mut reasons = Vec::new();
    for candidate in candidates {
        match load_member(candidate, p) {
            Ok(member) => return Ok(member),
            Err(e) => reasons.push(format!("{}: {e}", candidate.display())),
        }
    }
    if reasons.is_empty() {
        return Err("no caxa binary to read it from (CAXA_EXECUTABLE is unset)".into());
    }
    Err(format!("no valid caxa binary found ({})", reasons.join("; ")))
}

/// One candidate's verified, decoded frame; any defect moves on to the next
/// candidate.
fn load_member(candidate: &Path, p: &Placeholder) -> Result<(Vec<u8>, std::ops::Range<usize>)> {
    let compressed = read_source_frame(candidate, p)?;
    if sha256_hex(&compressed) != p.sha256 {
        return Err("sha256 mismatch".into());
    }
    let decoded = decode_frame(&compressed, p.uncompressed_size)?;
    let range = single_member(&decoded, &p.path, p.size)?;
    Ok((decoded, range))
}

/// Accept a candidate only if it is a v2 caxa binary whose identifier and
/// frame index entry match the placeholder; then read the compressed frame.
fn read_source_frame(candidate: &Path, p: &Placeholder) -> Result<Vec<u8>> {
    let mut file = File::open(candidate).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut magic = [0u8; 8];
    if size < TRAILER2_SIZE
        || file
            .seek(SeekFrom::Start(size - TRAILER2_SIZE))
            .and_then(|_| file.read_exact(&mut magic))
            .is_err()
        || magic != *TRAILER2_MAGIC
    {
        return Err("not a v2 caxa binary".into());
    }
    let layout = inspect_binary(candidate)?;
    if layout.config.identifier != p.identifier {
        return Err(format!("identifier is '{}'", layout.config.identifier));
    }
    let frame = usize::try_from(p.frame)
        .ok()
        .and_then(|i| layout.frames.get(i))
        .ok_or("frame not in index")?;
    if frame.compressed_offset != p.offset
        || frame.compressed_size != p.compressed_size
        || frame.uncompressed_size != p.uncompressed_size
    {
        return Err("frame index entry differs".into());
    }
    let offset = layout
        .payload_offset
        .checked_add(p.offset)
        .ok_or("frame offset overflow")?;
    let mut compressed = vec![0u8; p.compressed_size as usize];
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut compressed))
        .map_err(|e| format!("failed to read frame: {e}"))?;
    Ok(compressed)
}

fn decode_frame(compressed: &[u8], uncompressed_size: u64) -> Result<Vec<u8>> {
    let mut decoded = vec![0u8; uncompressed_size as usize];
    let mut decompressor = zstd::bulk::Decompressor::new().map_err(|e| e.to_string())?;
    decompressor
        .window_log_max(window_log_max())
        .map_err(|e| e.to_string())?;
    let decoded_len = decompressor
        .decompress_to_buffer(compressed, &mut decoded)
        .map_err(|e| format!("failed to decode frame: {e}"))?;
    if decoded_len as u64 != uncompressed_size {
        return Err(format!(
            "frame decoded to {decoded_len} bytes, expected {uncompressed_size}"
        ));
    }
    Ok(decoded)
}

/// A lazy frame must hold exactly one regular entry named `member`, of the
/// recorded size; returns the range of its content in `decoded`.
fn single_member(decoded: &[u8], member: &str, size: u64) -> Result<std::ops::Range<usize>> {
    if decoded.len() % 512 != 0 {
        return Err("frame does not end on a tar block boundary".into());
    }
    let mut archive = tar::Archive::new(Cursor::new(decoded));
    let mut found = None;
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if found.is_some() {
            return Err("frame holds more than one entry".into());
        }
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
        if path != Path::new(member) {
            return Err(format!("frame entry is {}, not {member}", path.display()));
        }
        if !matches!(
            entry.header().entry_type(),
            tar::EntryType::Regular | tar::EntryType::Continuous
        ) {
            return Err("frame entry is not a regular file".into());
        }
        if entry.size() != size {
            return Err(format!("frame entry is {} bytes, expected {size}", entry.size()));
        }
        let start = usize::try_from(entry.raw_file_position()).map_err(|e| e.to_string())?;
        let end = start
            .checked_add(size as usize)
            .filter(|e| *e <= decoded.len())
            .ok_or("entry outside frame")?;
        found = Some(start..end);
    }
    found.ok_or_else(|| "frame holds no entry".into())
}

/// Write the member to its own temp file next to the placeholder, then rename
/// it over the placeholder. Concurrent first runs each write their own temp
/// file and the last rename wins with identical bytes, so no partial file is
/// ever at the member path.
fn install_member(target: &Path, data: &[u8], mode: u32) -> Result<()> {
    let dir = target.parent().ok_or("placeholder has no directory")?;
    let name = target.file_name().ok_or("placeholder has no file name")?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let temp = dir.join(format!(".{}.caxa-{}-{nanos}", name.to_string_lossy(), process::id()));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let written = opts.open(&temp).and_then(|mut f| f.write_all(data));
    let result = written.and_then(|_| fs::rename(&temp, target));
    if let Err(e) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("failed to install member: {e}"));
    }
    Ok(())
}

/// exec `path` with this process's argv (argv[0] included) and environment.
#[cfg(unix)]
fn exec_path(path: &Path) -> io::Error {
    use std::os::unix::process::CommandExt;
    let mut args = env::args_os();
    let mut cmd = Command::new(path);
    if let Some(arg0) = args.next() {
        cmd.arg0(arg0);
    }
    cmd.args(args).exec()
}

#[cfg(not(unix))]
fn exec_path(path: &Path) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, format!("cannot exec {}", path.display()))
}

/// A placeholder that started just before a concurrent first run renamed its
/// member over it reads the member, not itself, at its own path (Linux avoids
/// this via /proc/self/exe). Exec that file only when it sits at a lazy member
/// path of the caxa binary in CAXA_EXECUTABLE: then it is the materialized
/// member. Returns when that is not the case.
fn exec_if_replaced(exe: &Path) {
    if cfg!(not(unix)) {
        return;
    }
    let Some(source) = env::var_os("CAXA_EXECUTABLE").filter(|v| !v.is_empty()) else {
        return;
    };
    if let Some(member) = replaced_member(exe, Path::new(&source)) {
        let err = exec_path(&member);
        fatal(&format!("failed to exec {}: {err}", member.display()))
    }
}

/// `exe`, canonicalized, when it is `<root>/apps/<identifier>/<attempt>/<path>`
/// for a lazy member of the caxa binary `source`.
fn replaced_member(exe: &Path, source: &Path) -> Option<PathBuf> {
    let layout = inspect_binary(source).ok()?;
    let path = fs::canonicalize(exe).ok()?;
    let is_member = layout.config.lazy.iter().any(|m| {
        path.ends_with(&m.path)
            && strip_member(&path, &m.path)
                .and_then(|app| app.parent().map(Path::to_path_buf))
                .is_some_and(|id_dir| {
                    id_dir
                        .file_name()
                        .is_some_and(|n| n == layout.config.identifier.as_str())
                        && id_dir.parent().and_then(Path::file_name).is_some_and(|n| n == "apps")
                })
    });
    is_member.then_some(path)
}

/// Decompress one frame with the declared uncompressed size as both the output
/// capacity and the acceptance check, then extract its tar entries.
fn extract_frame(file: &mut File, payload_offset: u64, frame: &FrameEntry, dest: &Path, dirs: &DirCache) -> Result<()> {
    let mut compressed = vec![0u8; frame.compressed_size as usize];
    let offset = payload_offset
        .checked_add(frame.compressed_offset)
        .ok_or("frame offset overflow")?;
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(&mut compressed))
        .map_err(|e| format!("failed to read frame: {e}"))?;

    let mut decoded = vec![0u8; frame.uncompressed_size as usize];
    let mut decompressor = zstd::bulk::Decompressor::new().map_err(|e| e.to_string())?;
    decompressor
        .window_log_max(window_log_max())
        .map_err(|e| e.to_string())?;
    let decoded_len = decompressor
        .decompress_to_buffer(&compressed, &mut decoded)
        .map_err(|e| format!("failed to decode frame: {e}"))?;
    if decoded_len as u64 != frame.uncompressed_size {
        return Err(format!(
            "frame decoded to {decoded_len} bytes, expected {}",
            frame.uncompressed_size
        ));
    }
    extract_frame_entries(&decoded, dest, dirs)
}

/// Write the whole tar entries of one frame. Frames other than the last have
/// no end-of-archive blocks; tar-rs ends iteration at EOF or at zero blocks.
fn extract_frame_entries(decoded: &[u8], dest: &Path, dirs: &DirCache) -> Result<()> {
    if decoded.len() % 512 != 0 {
        return Err("frame does not end on a tar block boundary".into());
    }
    let mut archive = tar::Archive::new(Cursor::new(decoded));
    for entry in archive.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        // Each frame already runs on its own thread: write small files inline.
        unpack_entry(&mut entry, dest, dirs, &mut |target, data, mode| {
            if let Some(p) = target.parent() {
                dirs.ensure(p).map_err(|e| e.to_string())?;
            }
            write_file(&target, &data, mode).map_err(|e| e.to_string())?;
            Ok(true)
        })?;
    }
    Ok(())
}

/// Unpack one tar entry below `dest`. Regular files under MAX_BUFFER_SIZE are
/// read into memory and handed to `small_file`, which returns false to stop
/// extraction; larger files are streamed to disk here. Unknown entry types are
/// skipped.
fn unpack_entry<R: Read>(
    entry: &mut tar::Entry<R>,
    dest: &Path,
    dirs: &DirCache,
    small_file: &mut dyn FnMut(PathBuf, Vec<u8>, u32) -> Result<bool>,
) -> Result<bool> {
    let path = entry.path().map_err(|e| e.to_string())?.into_owned();
    let target = safe_join(dest, &path)?;
    let header = entry.header();
    let mode = header.mode().unwrap_or(0o644);
    match header.entry_type() {
        tar::EntryType::Directory => dirs.ensure(&target).map_err(|e| e.to_string())?,
        tar::EntryType::Regular | tar::EntryType::Continuous => {
            let size = entry.size();
            if size < MAX_BUFFER_SIZE {
                let mut data = Vec::with_capacity(size as usize);
                entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
                return small_file(target, data, mode);
            }
            if let Some(p) = target.parent() {
                dirs.ensure(p).map_err(|e| e.to_string())?;
            }
            let mut opts = OpenOptions::new();
            opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(mode);
            }
            let mut f = opts.open(&target).map_err(|e| e.to_string())?;
            io::copy(entry, &mut f).map_err(|e| e.to_string())?;
        }
        tar::EntryType::Symlink => {
            if let Some(p) = target.parent() {
                dirs.ensure(p).map_err(|e| e.to_string())?;
            }
            let link = entry
                .link_name()
                .map_err(|e| e.to_string())?
                .ok_or("symlink without target")?
                .into_owned();
            let _ = fs::remove_file(&target);
            symlink(&link, &target).map_err(|e| e.to_string())?;
        }
        _ => {}
    }
    Ok(true)
}

fn extract_from(reader: Box<dyn Read + '_>, dest: &Path) -> Result<()> {
    let dirs = DirCache::default();
    let workers = thread::available_parallelism().map_or(4, |n| n.get());
    let (tx, rx) = sync_channel::<Job>(workers * 2);
    let rx: Arc<Mutex<Receiver<Job>>> = Arc::new(Mutex::new(rx));
    let failure: Arc<Mutex<Option<String>>> = Arc::default();

    let pool: Vec<_> = (0..workers)
        .map(|_| {
            let (rx, dirs, failure) = (rx.clone(), dirs.clone(), failure.clone());
            thread::spawn(move || loop {
                let job = match rx.lock().unwrap().recv() {
                    Ok(j) => j,
                    Err(_) => return,
                };
                let res = job
                    .dest
                    .parent()
                    .map_or(Ok(()), |p| dirs.ensure(p))
                    .and_then(|_| write_file(&job.dest, &job.data, job.mode));
                if let Err(e) = res {
                    failure.lock().unwrap().get_or_insert(e.to_string());
                    return;
                }
            })
        })
        .collect();

    let read_result = (|| -> Result<()> {
        let mut archive = tar::Archive::new(reader);
        for entry in archive.entries().map_err(|e| e.to_string())? {
            if failure.lock().unwrap().is_some() {
                return Ok(());
            }
            let mut entry = entry.map_err(|e| e.to_string())?;
            let more = unpack_entry(&mut entry, dest, &dirs, &mut |target, data, mode| {
                // false: the pool died; its error is in `failure`.
                Ok(tx
                    .send(Job {
                        dest: target,
                        data,
                        mode,
                    })
                    .is_ok())
            })?;
            if !more {
                return Ok(());
            }
        }
        Ok(())
    })();

    drop(tx);
    for t in pool {
        let _ = t.join();
    }
    read_result?;
    let failed = failure.lock().unwrap().take();
    failed.map_or(Ok(()), Err)
}

#[cfg(unix)]
fn symlink(src: &Path, dst: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(windows)]
fn symlink(src: &Path, dst: &Path) -> io::Result<()> {
    let resolved = dst.parent().map(|p| p.join(src)).unwrap_or_else(|| src.to_path_buf());
    if resolved.is_dir() {
        std::os::windows::fs::symlink_dir(src, dst)
    } else {
        std::os::windows::fs::symlink_file(src, dst)
    }
}

/// Replace every `{{ caxa }}` (whitespace-tolerant) with the app dir.
fn substitute(part: &str, app_dir: &str) -> String {
    let mut out = String::with_capacity(part.len());
    let mut rest = part;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let trimmed = after.trim_start();
        if let Some(tail) = trimmed.strip_prefix("caxa") {
            let tail_trimmed = tail.trim_start();
            if let Some(end) = tail_trimmed.strip_prefix("}}") {
                out.push_str(&rest[..start]);
                out.push_str(app_dir);
                rest = end;
                continue;
            }
        }
        out.push_str(&rest[..start + 2]);
        rest = after;
    }
    out.push_str(rest);
    out
}

fn run(config: &Config, exe: &Path, app_dir: &Path) -> Result<i32> {
    let app = app_dir.to_string_lossy();
    let mut args: Vec<String> = config.command.iter().map(|p| substitute(p, &app)).collect();
    args.extend(env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()));
    if args.is_empty() {
        return Err("no command defined".into());
    }

    let mut cmd = Command::new(&args[0]);
    cmd.args(&args[1..]);
    apply_compile_cache(&mut cmd, app_dir);

    // Bypass caxa's portable-node shell wrapper; it only sets the library path.
    if let Some((real, libs)) = resolve_portable_node(&args[0]) {
        cmd = Command::new(&real);
        cmd.args(&args[1..]);
        apply_compile_cache(&mut cmd, app_dir);
        let key = if cfg!(target_os = "macos") {
            "DYLD_LIBRARY_PATH"
        } else {
            "LD_LIBRARY_PATH"
        };
        let value = match env::var_os(key) {
            Some(existing) if !existing.is_empty() => {
                let mut v = libs.into_os_string();
                v.push(":");
                v.push(existing);
                v
            }
            _ => libs.into_os_string(),
        };
        cmd.env(key, value);
    }
    // Placeholders of lazy members find the payload through this; child
    // processes of the app inherit it. Windows has no placeholders, and
    // canonicalize would give it a \\?\ verbatim path.
    let caxa_exe = if cfg!(windows) {
        exe.to_path_buf()
    } else {
        fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf())
    };
    cmd.env("CAXA_EXECUTABLE", caxa_exe);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // exec only returns on failure.
        let err = cmd.exec();
        Err(format!("failed to exec {}: {err}", args[0]))
    }
    #[cfg(not(unix))]
    {
        let status = cmd.status().map_err(|e| e.to_string())?;
        Ok(status.code().unwrap_or(1))
    }
}

fn apply_compile_cache(cmd: &mut Command, app_dir: &Path) {
    if env::var_os("CAXA_DISABLE_COMPILE_CACHE").is_some_and(|v| !v.is_empty()) {
        return;
    }
    if env::var_os("NODE_COMPILE_CACHE").is_some() {
        return;
    }
    cmd.env("NODE_COMPILE_CACHE", app_dir.join(".node-compile-cache"));
}

fn resolve_portable_node(exe: &str) -> Option<(PathBuf, PathBuf)> {
    if cfg!(windows) {
        return None;
    }
    let real = PathBuf::from(format!("{exe}-real"));
    let libs = PathBuf::from(format!("{exe}-libs"));
    (real.is_file() && libs.is_dir()).then_some((real, libs))
}

#[cfg(test)]
mod tests;
