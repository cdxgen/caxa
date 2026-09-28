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
//! A long aligned frame (footer `aligned` or `lazy` entry with `parts`) is
//! several zstd frames in one index entry, which this stub decodes on
//! parallel threads; older stubs decode them as one stream.
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
//!
//! Background prefetch (Unix only): before the app is exec'd, the stub spawns
//! itself with `CAXA_PREFETCH_APP=<app dir>` as a low-priority, detached
//! prefetcher that materializes the members still sitting as placeholders.
//! Short commands therefore leave real files behind for the next run, and a
//! `CAXA_PREFETCH=0` start keeps the pure on-demand behaviour. The prefetcher
//! is best effort: it holds a pid lock at `locks/<id>/<attempt>.prefetch`,
//! writes the `.caxa-prefetched` marker when done, and exits 0 on any error.

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
/// Environment value that turns this binary into a background prefetcher
/// (Unix only; every platform keeps it from the app).
const PREFETCH_ENV: &str = "CAXA_PREFETCH_APP";
#[cfg(unix)]
const PREFETCH_DISABLE_ENV: &str = "CAXA_PREFETCH";
/// Suffix of the prefetch pid lock next to the extraction lock dir.
#[cfg(unix)]
const PREFETCH_LOCK_SUFFIX: &str = ".prefetch";
/// Written in the app dir once every member is materialized.
#[cfg(unix)]
const PREFETCH_MARKER: &str = ".caxa-prefetched";
/// A lock whose mtime is this old is replaced even when its pid looks alive.
#[cfg(unix)]
const PREFETCH_LOCK_STALE: Duration = Duration::from_secs(600);
/// The prefetcher runs at this nice level, below the app's priority.
#[cfg(unix)]
const PREFETCH_NICE: i32 = 10;

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
/// The packager's smallest part is 64 KiB, so a frame has at most this many.
const MAX_PARTS: usize = (MAX_FRAME_UNCOMPRESSED / (64 * 1024)) as usize;
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
    #[serde(default)]
    aligned: Vec<AlignedFrame>,
}

/// One zstd frame of a split frame: its compressed and decoded sizes.
///
/// The packager compresses a long aligned frame as several zstd frames, one
/// after another in the same index entry, so the stub can decode them on
/// parallel threads. Concatenated zstd frames are a valid zstd stream, which
/// stubs that predate `parts` decode in one pass, with the same result.
type Part = (u64, u64);

/// A footer `aligned` entry: a hot frame holding one large regular file laid
/// out for in-place decoding (see `in_place`), with the file's size. `parts`
/// is set when the frame is split (see `Part`).
#[derive(Debug, Clone, Deserialize)]
struct AlignedFrame {
    frame: u64,
    size: u64,
    #[serde(default)]
    parts: Vec<Part>,
}

/// A footer `lazy` entry: an executable in its own frame, materialized on
/// first use. `sha256` is over the frame's compressed bytes, all of its
/// `parts` when it is split.
#[derive(Debug, Clone, Deserialize)]
struct LazyMember {
    path: String,
    frame: u64,
    mode: u32,
    size: u64,
    sha256: String,
    #[serde(default)]
    parts: Vec<Part>,
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
    /// The member's `parts`; absent for a frame that is not split.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    parts: Vec<Part>,
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
    // Prefetch mode is checked right after the placeholder check and before
    // any extraction. Unix only: Windows cannot replace a running exe, so
    // there are no placeholders and nothing to prefetch there.
    #[cfg(unix)]
    if let Some(requested) = env::var_os(PREFETCH_ENV) {
        run_prefetcher(&exe, Some(&requested));
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
    // Spawn the background prefetcher before the app replaces this process,
    // on the cold start and on a warm start that still finds placeholders.
    #[cfg(unix)]
    spawn_prefetcher(&exe, &layout, &app_dir);
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
    if index_size == 0 || !index_size.is_multiple_of(INDEX_ENTRY_SIZE) {
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
    for entry in raw.as_chunks::<{ INDEX_ENTRY_SIZE as usize }>().0 {
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
            .is_none_or(|end| end > index_offset)
        {
            return Err("payload overlaps index".into());
        }
        let config = read_footer(&mut file, footer_offset, footer_size)?;
        if config.compression != "zstd" {
            return Err(format!("v2 payload requires zstd, not '{}'", config.compression));
        }
        let frames = read_index(&mut file, index_offset, index_size, payload_size)?;
        validate_lazy(&config.lazy, &frames)?;
        validate_aligned(&config.aligned, &config.lazy, &frames)?;
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
            .is_none_or(|end| end > footer_offset)
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
                    if waited.is_multiple_of(2000) {
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
    // Frames that decode in place hold no frame-sized buffer, so only the
    // others set the concurrency.
    let in_place = in_place_frames(layout);
    let biggest = order
        .iter()
        .filter(|i| !in_place.contains_key(i))
        .map(|&i| frames[i].uncompressed_size)
        .max()
        .unwrap_or(0);
    let cpus = thread::available_parallelism().map_or(2, |n| n.get()) as u64;
    let workers = (FRAME_MEMORY_BUDGET / biggest.max(1))
        .clamp(1, cpus)
        .min(order.len() as u64) as usize;

    let order = &order;
    let in_place = &in_place;
    let split = &split_frames(layout);
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
                let parts = split.get(&i).copied().unwrap_or_default();
                let extracted = match in_place.get(&i) {
                    Some(aligned) => {
                        extract_frame_in_place(&mut file, layout.payload_offset, &frames[i], i, aligned, dest, dirs)
                            .and_then(|done| {
                                if done {
                                    return Ok(());
                                }
                                extract_frame(&mut file, layout.payload_offset, &frames[i], parts, dest, dirs)
                            })
                    }
                    None => extract_frame(&mut file, layout.payload_offset, &frames[i], parts, dest, dirs),
                };
                if let Err(e) = extracted {
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

/// Hot frames that decode in place here, with their `aligned` entry: the
/// footer's entries whose layout checks out (Unix only).
fn in_place_frames(layout: &Layout) -> std::collections::HashMap<usize, &AlignedFrame> {
    #[cfg(unix)]
    {
        layout
            .config
            .aligned
            .iter()
            .filter_map(|a| {
                let i = usize::try_from(a.frame).ok()?;
                in_place::data_offset(a.size, layout.frames.get(i)?.uncompressed_size)?;
                Some((i, a))
            })
            .collect()
    }
    #[cfg(not(unix))]
    {
        let _ = layout;
        std::collections::HashMap::new()
    }
}

/// The parts of every split frame this layout extracts eagerly: aligned hot
/// frames, and the lazy members of a platform that does not honour them.
fn split_frames(layout: &Layout) -> std::collections::HashMap<usize, &[Part]> {
    let aligned = layout.config.aligned.iter().map(|a| (a.frame, a.parts.as_slice()));
    let lazy = if lazy_members(&layout.config).is_empty() {
        layout.config.lazy.as_slice()
    } else {
        &[]
    };
    aligned
        .chain(lazy.iter().map(|m| (m.frame, m.parts.as_slice())))
        .filter(|(_, parts)| parts.len() > 1)
        .filter_map(|(frame, parts)| Some((usize::try_from(frame).ok()?, parts)))
        .collect()
}

/// Decode an aligned hot frame straight into its file (see `in_place`).
/// Ok(false) sends the frame down the buffered path.
#[cfg(unix)]
fn extract_frame_in_place(
    file: &mut File,
    payload_offset: u64,
    frame: &FrameEntry,
    index: usize,
    aligned: &AlignedFrame,
    dest: &Path,
    dirs: &DirCache,
) -> Result<bool> {
    let size = aligned.size;
    let Some(h) = in_place::data_offset(size, frame.uncompressed_size) else {
        return Ok(false);
    };
    let offset = payload_offset
        .checked_add(frame.compressed_offset)
        .ok_or("frame offset overflow")?;
    let expected = in_place::Expected {
        path: None,
        mode: None,
        size,
        compressed_size: frame.compressed_size,
        uncompressed_size: frame.uncompressed_size,
        sha256: None,
        parts: &aligned.parts,
        threads: part_threads(),
    };
    // The entry's path is known once its header is decoded: the temp file
    // starts in the app dir's root and is renamed into place after checks.
    dirs.ensure(dest).map_err(|e| e.to_string())?;
    let temp_near = dest.join(format!("frame-{index}"));
    in_place::install(file, offset, &expected, h, &temp_near, &mut |path| {
        let target = safe_join(dest, path)?;
        if let Some(parent) = target.parent() {
            dirs.ensure(parent).map_err(|e| e.to_string())?;
        }
        Ok(target)
    })
    .map_err(|e| format!("frame {index}: {e}"))
}

#[cfg(not(unix))]
fn extract_frame_in_place(
    _file: &mut File,
    _payload_offset: u64,
    _frame: &FrameEntry,
    _index: usize,
    _aligned: &AlignedFrame,
    _dest: &Path,
    _dirs: &DirCache,
) -> Result<bool> {
    Ok(false)
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
        check_parts(&member.parts, frame.compressed_size, frame.uncompressed_size)
            .map_err(|e| format!("lazy member {}: {e}", member.path))?;
    }
    Ok(())
}

/// A split frame's parts must be non-empty zstd frames that together are
/// exactly the frame; no parts at all means the frame is not split.
fn check_parts(parts: &[Part], compressed_size: u64, uncompressed_size: u64) -> Result<()> {
    if parts.is_empty() {
        return Ok(());
    }
    if parts.len() > MAX_PARTS {
        return Err("too many parts".into());
    }
    let mut compressed = 0u64;
    let mut uncompressed = 0u64;
    for &(c, u) in parts {
        if c == 0 || u == 0 {
            return Err("empty part".into());
        }
        compressed = compressed.checked_add(c).ok_or("part size overflow")?;
        uncompressed = uncompressed.checked_add(u).ok_or("part size overflow")?;
    }
    if compressed != compressed_size || uncompressed != uncompressed_size {
        return Err("parts do not cover the frame".into());
    }
    Ok(())
}

/// Footer `aligned` entries must name distinct hot frames of this payload,
/// each larger than its file.
fn validate_aligned(aligned: &[AlignedFrame], lazy: &[LazyMember], frames: &[FrameEntry]) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for entry in aligned {
        let frame = usize::try_from(entry.frame)
            .ok()
            .and_then(|i| frames.get(i))
            .ok_or_else(|| format!("aligned frame {} is missing", entry.frame))?;
        if !seen.insert(entry.frame) || lazy.iter().any(|m| m.frame == entry.frame) {
            return Err(format!("aligned frame {} is listed twice", entry.frame));
        }
        if entry.size > frame.uncompressed_size {
            return Err(format!("aligned frame {} is smaller than its file", entry.frame));
        }
        check_parts(&entry.parts, frame.compressed_size, frame.uncompressed_size)
            .map_err(|e| format!("aligned frame {}: {e}", entry.frame))?;
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
    hex(&Sha256::digest(data))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
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
            parts: member.parts.clone(),
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
    check_parts(&p.parts, p.compressed_size, p.uncompressed_size).map_err(|e| format!("placeholder: {e}"))
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
        materialize_member(&placeholder, &target)?;
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
/// recorded path) and install the verified member at `target`.
fn materialize_member(p: &Placeholder, target: &Path) -> Result<()> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(v) = env::var_os("CAXA_EXECUTABLE").filter(|v| !v.is_empty()) {
        candidates.push(PathBuf::from(v));
    }
    if !p.source.is_empty() {
        candidates.push(PathBuf::from(&p.source));
    }
    materialize_into(&candidates, p, target)
}

/// The first run of a placeholder waits for its member, so a split frame
/// decodes on every core.
fn materialize_into(candidates: &[PathBuf], p: &Placeholder, target: &Path) -> Result<()> {
    let mut buffers = FrameBuffers::default();
    let mut reasons = Vec::new();
    for candidate in candidates {
        match install_from(candidate, p, target, &mut buffers, part_threads()) {
            Ok(()) => return Ok(()),
            Err(e) => reasons.push(format!("{}: {e}", candidate.display())),
        }
    }
    if reasons.is_empty() {
        return Err("no caxa binary to read it from (CAXA_EXECUTABLE is unset)".into());
    }
    Err(format!("no valid caxa binary found ({})", reasons.join("; ")))
}

/// The compressed and decoded frame of the buffer path. Owned by the caller,
/// so the prefetcher reuses one pair for every member instead of allocating
/// (and, with some allocators, retaining) a pair per member.
#[derive(Default)]
struct FrameBuffers {
    compressed: Vec<u8>,
    decoded: Vec<u8>,
}

/// Install the member at `target` from one candidate; any defect moves on to
/// the next candidate. An aligned frame decodes straight into the member's
/// file (Unix, see `in_place`), a split one on up to `threads` threads. Any
/// other frame, or an aligned one whose file cannot be preallocated and
/// mapped here, is verified and decoded in `buffers`, then written.
fn install_from(
    candidate: &Path,
    p: &Placeholder,
    target: &Path,
    buffers: &mut FrameBuffers,
    threads: usize,
) -> Result<()> {
    #[cfg(unix)]
    if let Some(data_offset) = in_place::data_offset(p.size, p.uncompressed_size) {
        let (mut source, offset) = open_source_frame(candidate, p)?;
        let expected = in_place::Expected::member(p, threads);
        if in_place::install(&mut source, offset, &expected, data_offset, target, &mut |_| {
            Ok(target.to_path_buf())
        })? {
            return Ok(());
        }
    }
    #[cfg(not(unix))]
    let _ = threads;
    let range = load_member_into(candidate, p, &mut buffers.compressed, &mut buffers.decoded)?;
    install_member(target, &buffers.decoded[range], p.mode)
}

/// One candidate's verified, decoded frame in caller-owned buffers. Returns
/// the member's range in `decoded`.
fn load_member_into(
    candidate: &Path,
    p: &Placeholder,
    compressed: &mut Vec<u8>,
    decoded: &mut Vec<u8>,
) -> Result<std::ops::Range<usize>> {
    read_source_frame(candidate, p, compressed)?;
    if sha256_hex(compressed) != p.sha256 {
        return Err("sha256 mismatch".into());
    }
    decode_frame_into(compressed, p.uncompressed_size, decoded)?;
    single_member(decoded, &p.path, p.size)
}

/// Read the candidate's compressed frame into `compressed`, replacing its
/// contents (see `open_source_frame`).
fn read_source_frame(candidate: &Path, p: &Placeholder, compressed: &mut Vec<u8>) -> Result<()> {
    let (mut file, offset) = open_source_frame(candidate, p)?;
    resize_buffer(compressed, p.compressed_size as usize);
    file.seek(SeekFrom::Start(offset))
        .and_then(|_| file.read_exact(compressed))
        .map_err(|e| format!("failed to read frame: {e}"))?;
    Ok(())
}

/// Accept a candidate only if it is a v2 caxa binary whose identifier and
/// frame index entry match the placeholder. Returns the open binary and the
/// absolute offset of the compressed frame.
fn open_source_frame(candidate: &Path, p: &Placeholder) -> Result<(File, u64)> {
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
    Ok((file, offset))
}

/// Set `buffer` to exactly `len` bytes. A buffer that is too small is freed
/// before its replacement is allocated, so growing never holds both.
fn resize_buffer(buffer: &mut Vec<u8>, len: usize) {
    if buffer.capacity() < len {
        *buffer = Vec::new();
        *buffer = vec![0u8; len];
    } else {
        buffer.resize(len, 0);
    }
}

/// Decode into `decoded`, sized to exactly the declared size: that length is
/// both the output bound and the acceptance check.
fn decode_frame_into(compressed: &[u8], uncompressed_size: u64, decoded: &mut Vec<u8>) -> Result<()> {
    resize_buffer(decoded, uncompressed_size as usize);
    let mut decompressor = zstd::bulk::Decompressor::new().map_err(|e| e.to_string())?;
    decompressor
        .window_log_max(window_log_max())
        .map_err(|e| e.to_string())?;
    let decoded_len = decompressor
        .decompress_to_buffer(compressed, &mut decoded[..])
        .map_err(|e| format!("failed to decode frame: {e}"))?;
    if decoded_len as u64 != uncompressed_size {
        return Err(format!(
            "frame decoded to {decoded_len} bytes, expected {uncompressed_size}"
        ));
    }
    Ok(())
}

/// Threads for decoding a split frame: all cores, or two when unknown.
fn part_threads() -> usize {
    thread::available_parallelism().map_or(2, |n| n.get())
}

/// Read up to `buf.len()` bytes at `offset` without moving a shared cursor,
/// so several threads can read one file; 0 is the end of the file.
fn read_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<usize> {
    loop {
        #[cfg(unix)]
        let read = std::os::unix::fs::FileExt::read_at(file, buf, offset);
        #[cfg(windows)]
        let read = std::os::windows::fs::FileExt::seek_read(file, buf, offset);
        match read {
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            other => return other,
        }
    }
}

/// `read_at` until `buf` is full.
fn read_exact_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    let mut done = 0;
    while done < buf.len() {
        match read_at(file, &mut buf[done..], offset + done as u64)? {
            0 => return Err(io::ErrorKind::UnexpectedEof.into()),
            n => done += n,
        }
    }
    Ok(())
}

/// Decode a split frame, the `parts` at `offset` of `source`, into `out`: each
/// part into its own range, on up to `threads` threads. Without `hash`, each
/// part streams through one chunk (see `stream_decode`), so the heap holds a
/// chunk per thread whatever the frame's size. With `hash`, each part is read
/// whole and decoded from that buffer, and the sha256 of the compressed bytes
/// is computed in order from the very buffers decoded, so what is hashed is
/// what lands in `out`. A failed read is reported first; then, with `hash`, a
/// hash that does not match the caller's, which is why the hash is returned
/// even when a part fails to decode.
fn decode_parts(
    source: &File,
    offset: u64,
    parts: &[Part],
    out: &mut [u8],
    threads: usize,
    hash: bool,
) -> Result<(Option<String>, Result<()>)> {
    let mut jobs = Vec::with_capacity(parts.len());
    let mut rest = out;
    let mut at = offset;
    for (i, &(compressed, uncompressed)) in parts.iter().enumerate() {
        let len = usize::try_from(uncompressed).map_err(|e| e.to_string())?;
        if len > rest.len() {
            return Err("parts do not cover the frame".into());
        }
        let (slice, tail) = std::mem::take(&mut rest).split_at_mut(len);
        jobs.push((i, at, compressed, slice));
        at = at.checked_add(compressed).ok_or("frame offset overflow")?;
        rest = tail;
    }
    if !rest.is_empty() {
        return Err("parts do not cover the frame".into());
    }
    let threads = threads.clamp(1, jobs.len().max(1));
    let mut queues: Vec<Vec<_>> = (0..threads).map(|_| Vec::new()).collect();
    for (n, job) in jobs.into_iter().enumerate() {
        queues[n % threads].push(job);
    }

    let (tx, rx) = std::sync::mpsc::channel::<(usize, Arc<Vec<u8>>)>();
    let mut read_failure: Option<String> = None;
    let mut decode_failure: Option<String> = None;
    let mut digest = None;
    thread::scope(|scope| {
        let workers: Vec<_> = queues
            .into_iter()
            .map(|queue| {
                let tx = tx.clone();
                scope.spawn(move || -> std::result::Result<Option<String>, String> {
                    let mut failure = None;
                    if !hash {
                        for (_, at, compressed, slice) in queue {
                            if let Err(e) = stream_decode(source, at, compressed, slice, None)? {
                                failure.get_or_insert(e);
                            }
                        }
                        return Ok(failure);
                    }
                    let mut decompressor = zstd::bulk::Decompressor::new().map_err(|e| e.to_string())?;
                    decompressor
                        .window_log_max(window_log_max())
                        .map_err(|e| e.to_string())?;
                    for (i, at, compressed, slice) in queue {
                        let mut buf = vec![0u8; compressed as usize];
                        read_exact_at(source, &mut buf, at).map_err(|e| format!("failed to read frame: {e}"))?;
                        let buf = Arc::new(buf);
                        let _ = tx.send((i, buf.clone()));
                        if failure.is_some() {
                            continue;
                        }
                        match decompressor.decompress_to_buffer(buf.as_slice(), &mut slice[..]) {
                            Ok(n) if n == slice.len() => {}
                            Ok(n) => failure = Some(format!("part {i} decoded to {n} bytes, expected {}", slice.len())),
                            Err(e) => failure = Some(format!("failed to decode frame: {e}")),
                        }
                    }
                    Ok(failure)
                })
            })
            .collect();
        drop(tx);
        if hash {
            let mut hasher = Sha256::new();
            let mut pending: Vec<Option<Arc<Vec<u8>>>> = vec![None; parts.len()];
            let mut next = 0;
            for (i, buf) in rx {
                pending[i] = Some(buf);
                while let Some(buf) = pending.get_mut(next).and_then(Option::take) {
                    hasher.update(buf.as_slice());
                    next += 1;
                }
            }
            if next == parts.len() {
                digest = Some(hex(&hasher.finalize()));
            }
        }
        for worker in workers {
            match worker.join() {
                Ok(Ok(failure)) => {
                    if decode_failure.is_none() {
                        decode_failure = failure;
                    }
                }
                Ok(Err(e)) => {
                    read_failure.get_or_insert(e);
                }
                Err(_) => {
                    read_failure.get_or_insert_with(|| "a decoding thread panicked".into());
                }
            }
        }
    });
    if let Some(e) = read_failure {
        return Err(e);
    }
    Ok((digest, decode_failure.map_or(Ok(()), Err)))
}

/// A lazy frame must hold exactly one regular entry named `member`, of the
/// recorded size; returns the range of its content in `decoded`.
fn single_member(decoded: &[u8], member: &str, size: u64) -> Result<std::ops::Range<usize>> {
    let entry = single_entry(decoded, size)?;
    if entry.path != Path::new(member) {
        return Err(format!("frame entry is {}, not {member}", entry.path.display()));
    }
    Ok(entry.range)
}

/// The one regular entry of a single-entry frame.
struct SingleEntry {
    path: PathBuf,
    /// Read by the in-place path only (Unix).
    #[cfg_attr(not(unix), allow(dead_code))]
    mode: u32,
    range: std::ops::Range<usize>,
}

/// A frame that must hold exactly one regular entry of `size` bytes. Entry
/// data is skipped by seeking, never read.
fn single_entry(decoded: &[u8], size: u64) -> Result<SingleEntry> {
    if !decoded.len().is_multiple_of(512) {
        return Err("frame does not end on a tar block boundary".into());
    }
    let mut archive = tar::Archive::new(Cursor::new(decoded));
    let mut found = None;
    for entry in archive.entries_with_seek().map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if found.is_some() {
            return Err("frame holds more than one entry".into());
        }
        let path = entry.path().map_err(|e| e.to_string())?.into_owned();
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
        let mode = entry.header().mode().unwrap_or(0o644);
        found = Some(SingleEntry {
            path,
            mode,
            range: start..end,
        });
    }
    found.ok_or_else(|| "frame holds no entry".into())
}

/// Write the member to its own temp file next to the placeholder, then rename
/// it over the placeholder. Concurrent first runs each write their own temp
/// file and the last rename wins with identical bytes, so no partial file is
/// ever at the member path.
fn install_member(target: &Path, data: &[u8], mode: u32) -> Result<()> {
    TempMember::create(target, mode)
        .and_then(|temp| {
            temp.file().write_all(data)?;
            temp.commit(target)
        })
        .map_err(|e| format!("failed to install member: {e}"))
}

/// A member's temp file, `.{name}.caxa-{pid}-{nanos}` next to it, created with
/// `create_new` and the member's mode. It is removed when dropped, unless
/// `commit` renamed it over the member.
struct TempMember {
    path: PathBuf,
    file: Option<File>,
    /// The flock that keeps a sweep away, on a read-only descriptor held until
    /// after the rename (see `sweep_abandoned_temps`).
    #[cfg(unix)]
    _lock: Option<File>,
    committed: bool,
}

impl TempMember {
    fn create(target: &Path, mode: u32) -> io::Result<Self> {
        let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
            return Err(io::Error::other("placeholder has no directory or file name"));
        };
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let path = dir.join(format!(".{}.caxa-{}-{nanos}", name.to_string_lossy(), process::id()));
        let mut opts = OpenOptions::new();
        // Readable too: a shared writable mapping needs it (see `in_place`).
        opts.read(true).write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(mode);
        }
        #[cfg(not(unix))]
        let _ = mode;
        let file = opts.open(&path)?;
        Ok(Self {
            #[cfg(unix)]
            _lock: File::open(&path).ok().inspect(|lock| {
                lock_exclusive(lock, false);
            }),
            path,
            file: Some(file),
            committed: false,
        })
    }

    fn file(&self) -> &File {
        self.file
            .as_ref()
            .expect("the writable descriptor is open until commit")
    }

    /// Close the writable descriptor, then rename the temp file over `target`.
    /// Closed first because Linux refuses to exec a file that is open for
    /// writing (ETXTBSY), and a concurrent first run execs the member the
    /// moment it appears at its path. Concurrent first runs each rename their
    /// own temp file and the last rename wins with identical bytes, so no
    /// partial file is ever at the member path.
    fn commit(mut self, target: &Path) -> io::Result<()> {
        drop(self.file.take());
        fs::rename(&self.path, target)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for TempMember {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// In-place materialization (Unix). The packager pads every lazy frame's pax
/// header so the member's data starts at a 64 KiB-aligned offset `h` of the
/// decoded frame, which ends right after the data's 512-byte padding, so `h`
/// follows from the frame and member sizes alone. The stub reserves the
/// frame's address range, backs `[0, h)` with anonymous memory, and maps the
/// member's temp file, preallocated to the padded size, at `h`. It then
/// decodes the frame into that range as a stream: compressed chunks go in,
/// and zstd writes straight into the mapping (a stable output buffer, so it
/// keeps no window or output buffer of its own). The heap holds one chunk and
/// zstd's block buffer whatever the member's size, and the member's bytes
/// live only in the page cache. The chunks are hashed on the way in: the temp
/// file becomes the member only after the sha256, the decoded size and the
/// tar header (path, type, size, data offset) all match, so unverified bytes
/// never reach the member path. On macOS the verified bytes are then copied
/// into a fresh file with write() (see `install`).
///
/// A split frame (see `Part`) decodes on parallel threads instead, each part
/// straight into its own range of the mapping (`decode_parts`); the heap then
/// holds the compressed parts, hashed in order from the buffers decoded.
#[cfg(unix)]
mod in_place {
    use super::*;
    use std::os::unix::io::AsRawFd;

    fn page_size() -> u64 {
        match unsafe { libc::sysconf(libc::_SC_PAGESIZE) } {
            size if size > 0 => size as u64,
            _ => 4096,
        }
    }

    /// The data offset of a frame laid out for in-place decoding: the frame
    /// ends at the entry's padded end, and the data starts on a page.
    pub(super) fn data_offset(size: u64, uncompressed_size: u64) -> Option<usize> {
        let padded = size.checked_next_multiple_of(512)?;
        let offset = uncompressed_size.checked_sub(padded)?;
        (size > 0 && offset > 0 && offset.is_multiple_of(page_size())).then_some(offset as usize)
    }

    /// What a frame decoded in place must hold. A lazy member knows its path,
    /// mode and sha256; a hot frame (`None`) takes its path and mode from its
    /// tar entry and, like every hot frame, carries no hash. A split frame
    /// (`parts`) decodes on up to `threads` threads; with one thread, or
    /// unsplit, it streams through one small buffer.
    pub(super) struct Expected<'a> {
        pub(super) path: Option<&'a str>,
        pub(super) mode: Option<u32>,
        pub(super) size: u64,
        pub(super) compressed_size: u64,
        pub(super) uncompressed_size: u64,
        pub(super) sha256: Option<&'a str>,
        pub(super) parts: &'a [Part],
        pub(super) threads: usize,
    }

    impl<'a> Expected<'a> {
        pub(super) fn member(p: &'a Placeholder, threads: usize) -> Self {
            Self {
                path: Some(&p.path),
                mode: Some(p.mode),
                size: p.size,
                compressed_size: p.compressed_size,
                uncompressed_size: p.uncompressed_size,
                sha256: Some(&p.sha256),
                parts: &p.parts,
                threads,
            }
        }
    }

    /// Decode the frame at `offset` of `source` into a temp file next to
    /// `temp_near`, then rename it to `place(entry path)`. Ok(false) when this
    /// filesystem cannot preallocate or map the file: nothing is left behind,
    /// and the caller takes the buffered path. Any other failure leaves no
    /// file behind either.
    pub(super) fn install(
        source: &mut File,
        offset: u64,
        expected: &Expected,
        h: usize,
        temp_near: &Path,
        place: &mut dyn FnMut(&Path) -> Result<PathBuf>,
    ) -> Result<bool> {
        let installing = |e: io::Error| format!("failed to install member: {e}");
        let total = expected.uncompressed_size as usize;
        let file_len = (total - h) as u64;
        let temp = TempMember::create(temp_near, expected.mode.unwrap_or(0o600)).map_err(installing)?;
        // Preallocated, so a full disk fails here and not as a SIGBUS on a
        // write through the mapping.
        if !preallocate(temp.file(), file_len) {
            return Ok(false);
        }
        temp.file().set_len(file_len).map_err(installing)?;
        let Some(mut map) = FrameMap::new(temp.file(), h, total) else {
            return Ok(false);
        };
        decode_into(source, offset, expected, map.as_mut_slice())?;
        let entry = single_entry(map.as_slice(), expected.size)?;
        if let Some(member) = expected.path {
            if entry.path != Path::new(member) {
                return Err(format!("frame entry is {}, not {member}", entry.path.display()));
            }
        }
        if entry.range.start != h {
            return Err(format!("frame entry data is at {}, expected {h}", entry.range.start));
        }
        let target = place(&entry.path)?;
        let mode = expected.mode.unwrap_or(entry.mode);
        // macOS kills a signed binary (osqueryd, for one) at exec when its
        // pages were written through a writable mapping, although the bytes
        // are identical; a copy written with write() runs. So there the
        // member is written once more, from the mapping, into a fresh temp
        // file, and the mapped one is dropped.
        #[cfg(target_os = "macos")]
        {
            let fresh = TempMember::create(&target, mode).map_err(installing)?;
            fresh
                .file()
                .write_all(&map.as_slice()[entry.range])
                .map_err(installing)?;
            drop(map);
            drop(temp);
            fresh.commit(&target).map_err(installing)?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            use std::os::unix::fs::PermissionsExt;
            drop(map);
            temp.file().set_len(expected.size).map_err(installing)?;
            if expected.mode.is_none() {
                // As a file created with this mode would get it.
                temp.file()
                    .set_permissions(fs::Permissions::from_mode(mode & !umask()))
                    .map_err(installing)?;
            }
            temp.commit(&target).map_err(installing)?;
        }
        Ok(true)
    }

    /// The process umask, read without changing it (umask(2) can only swap
    /// it, which races with other extraction threads).
    #[cfg(not(target_os = "macos"))]
    fn umask() -> u32 {
        fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                let line = status.lines().find(|l| l.starts_with("Umask:"))?;
                u32::from_str_radix(line["Umask:".len()..].trim(), 8).ok()
            })
            .unwrap_or(0o022)
    }

    #[cfg(target_os = "linux")]
    fn preallocate(file: &File, len: u64) -> bool {
        let Ok(len) = libc::off_t::try_from(len) else {
            return false;
        };
        unsafe { libc::posix_fallocate(file.as_raw_fd(), 0, len) == 0 }
    }

    #[cfg(target_os = "macos")]
    fn preallocate(file: &File, len: u64) -> bool {
        let Ok(len) = libc::off_t::try_from(len) else {
            return false;
        };
        let mut store = libc::fstore_t {
            fst_flags: libc::F_ALLOCATEALL,
            fst_posmode: libc::F_PEOFPOSMODE,
            fst_offset: 0,
            fst_length: len,
            fst_bytesalloc: 0,
        };
        unsafe { libc::fcntl(file.as_raw_fd(), libc::F_PREALLOCATE, &mut store) != -1 }
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    fn preallocate(_file: &File, _len: u64) -> bool {
        false
    }

    /// `[0, h)` anonymous, `[h, total)` the file from its start; unmapped on
    /// drop, which ends the file's writable mapping before any rename.
    struct FrameMap {
        base: *mut u8,
        len: usize,
        total: usize,
    }

    impl FrameMap {
        fn new(file: &File, h: usize, total: usize) -> Option<Self> {
            let len = total.checked_next_multiple_of(page_size() as usize)?;
            let prot = libc::PROT_READ | libc::PROT_WRITE;
            // SAFETY: a fresh private anonymous mapping, then a fixed shared
            // mapping of our own temp file inside it, at a page-aligned offset.
            // Its length rounds the file's (the padded data) up to a page, so
            // no page of it lies wholly past the end of the file.
            unsafe {
                let base = libc::mmap(
                    std::ptr::null_mut(),
                    len,
                    prot,
                    libc::MAP_PRIVATE | libc::MAP_ANON,
                    -1,
                    0,
                );
                if base == libc::MAP_FAILED {
                    return None;
                }
                let at = libc::mmap(
                    base.cast::<u8>().add(h).cast(),
                    len - h,
                    prot,
                    libc::MAP_SHARED | libc::MAP_FIXED,
                    file.as_raw_fd(),
                    0,
                );
                if at == libc::MAP_FAILED {
                    libc::munmap(base, len);
                    return None;
                }
                Some(Self {
                    base: base.cast(),
                    len,
                    total,
                })
            }
        }

        fn as_slice(&self) -> &[u8] {
            // SAFETY: `total` bytes of the mapping, which lives as long as self.
            unsafe { std::slice::from_raw_parts(self.base, self.total) }
        }

        fn as_mut_slice(&mut self) -> &mut [u8] {
            // SAFETY: as in `as_slice`, borrowed mutably through self.
            unsafe { std::slice::from_raw_parts_mut(self.base, self.total) }
        }
    }

    impl Drop for FrameMap {
        fn drop(&mut self) {
            // SAFETY: the whole range mapped in `new`.
            unsafe { libc::munmap(self.base.cast(), self.len) };
        }
    }

    /// Decode the frame at `offset` into `out`: a split frame on parallel
    /// threads when more than one is allowed, anything else as a stream. A
    /// frame whose hash does not match reports that, even when it also fails
    /// to decode.
    fn decode_into(source: &mut File, offset: u64, expected: &Expected, out: &mut [u8]) -> Result<()> {
        if expected.parts.len() < 2 || expected.threads < 2 {
            return stream_into(source, offset, expected, out);
        }
        let (digest, decoded) = decode_parts(
            source,
            offset,
            expected.parts,
            out,
            expected.threads,
            expected.sha256.is_some(),
        )?;
        if let Some(sha256) = expected.sha256 {
            if digest.as_deref() != Some(sha256) {
                return Err("sha256 mismatch".into());
            }
        }
        decoded
    }

    /// Stream-decode the frame at `offset` into `out` (see `stream_decode`),
    /// hashing the compressed bytes on the way in when a hash is expected.
    fn stream_into(source: &File, offset: u64, expected: &Expected, out: &mut [u8]) -> Result<()> {
        let mut hasher = expected.sha256.map(|_| Sha256::new());
        let decoded = stream_decode(source, offset, expected.compressed_size, out, hasher.as_mut())?;
        if let (Some(hasher), Some(sha256)) = (hasher, expected.sha256) {
            if hex(&hasher.finalize()) != sha256 {
                return Err("sha256 mismatch".into());
            }
        }
        decoded
    }
}

/// Compressed bytes read (and hashed) per step of a streaming decode.
const STREAM_CHUNK: usize = 1 << 20;

/// Stream-decode the `compressed` bytes at `offset` of `source` into `out`
/// through one chunk: zstd writes straight into `out` (a stable output buffer,
/// so it keeps no window or output buffer of its own), and the heap holds the
/// chunk and zstd's block buffer whatever the size. The zstd frames of a split
/// frame decode one after another, as one stream. Reads are positional, so
/// threads can share `source`. Every chunk goes into `hasher`, even after a
/// decode failure, so the caller can report a hash mismatch first; the outer
/// error is a failed read, the inner result the decode's.
fn stream_decode(
    source: &File,
    offset: u64,
    compressed: u64,
    out: &mut [u8],
    mut hasher: Option<&mut Sha256>,
) -> Result<Result<()>> {
    use zstd::zstd_safe::{get_error_name, DCtx, DParameter, InBuffer, OutBuffer};

    let zstd_error = |code: usize| format!("failed to decode frame: {}", get_error_name(code));
    let mut dctx = DCtx::try_create().ok_or("failed to decode frame: no zstd context")?;
    dctx.set_parameter(DParameter::WindowLogMax(window_log_max()))
        .map_err(zstd_error)?;
    dctx.set_parameter(DParameter::StableOutBuffer(true))
        .map_err(zstd_error)?;
    let mut chunk = vec![0u8; STREAM_CHUNK.min(usize::try_from(compressed).unwrap_or(STREAM_CHUNK))];
    let out_len = out.len();
    let mut output = OutBuffer::around(out);
    let mut failure: Option<String> = None;
    let mut finished = false;
    let mut done = 0u64;
    while done < compressed {
        let want = chunk
            .len()
            .min(usize::try_from(compressed - done).unwrap_or(chunk.len()));
        let at = offset.checked_add(done).ok_or("frame offset overflow")?;
        let n = read_at(source, &mut chunk[..want], at).map_err(|e| format!("failed to read frame: {e}"))?;
        if n == 0 {
            return Err("failed to read frame: the binary ends inside it".into());
        }
        done += n as u64;
        if let Some(hasher) = hasher.as_deref_mut() {
            hasher.update(&chunk[..n]);
        }
        if failure.is_some() {
            continue;
        }
        let mut input = InBuffer::around(&chunk[..n]);
        while input.pos() < n {
            // 0 ends a zstd frame; more input starts the next one, and
            // anything but a frame there fails to decode.
            match dctx.decompress_stream(&mut output, &mut input) {
                Ok(0) => finished = true,
                Ok(_) => finished = false,
                Err(code) => {
                    failure = Some(zstd_error(code));
                    break;
                }
            }
        }
    }
    if let Some(failure) = failure {
        return Ok(Err(failure));
    }
    if !finished || output.pos() != out_len {
        return Ok(Err(format!(
            "frame decoded to {} bytes, expected {out_len}",
            output.pos()
        )));
    }
    Ok(Ok(()))
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

// --- background prefetch (Unix only) ---
//
// On Windows lazy members are extracted eagerly and placeholders never
// exist, so none of this runs: the spawn is skipped (no lazy members on
// Windows) and CAXA_PREFETCH_APP is never read.

/// The body of a prefetcher: this binary re-run by a parent stub with
/// CAXA_PREFETCH_APP set. Never an error surface for the app — every failure
/// exits 0 silently, after removing this process's lock and temp files.
#[cfg(unix)]
fn run_prefetcher(exe: &Path, requested: Option<&std::ffi::OsStr>) -> ! {
    close_inherited_fds();
    // Dropped explicitly: process::exit never unwinds.
    drop(try_prefetch(exe, requested));
    process::exit(0);
}

/// Close every descriptor above stderr that the prefetcher inherited from the
/// stub's parent. The prefetcher outlives the app, so a parent that waits for
/// EOF on an extra pipe it passed down (Node's `stdio: [.., .., .., "pipe"]`,
/// for example) would otherwise wait for the prefetcher too.
#[cfg(unix)]
fn close_inherited_fds() {
    let listed: Option<Vec<i32>> = fs::read_dir("/dev/fd").ok().map(|entries| {
        entries
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .collect()
    });
    // The directory's own descriptor is in the list but already closed: a
    // second close is a harmless EBADF. Without /dev/fd, a bounded sweep.
    let fds = listed.unwrap_or_else(|| (0..1024).collect());
    for fd in fds.into_iter().filter(|fd| *fd > 2) {
        unsafe { libc::close(fd) };
    }
}

/// Run the prefetch work. The lock guard is held until the work is done, so
/// it must be dropped before this process exits.
#[cfg(unix)]
fn try_prefetch(exe: &Path, requested: Option<&std::ffi::OsStr>) -> Option<PrefetchLock> {
    let root = fs::canonicalize(temp_root()).unwrap_or_else(|_| temp_root());
    try_prefetch_in(exe, requested, &root)
}

/// Everything a prefetcher does, against an explicit temp root so tests can
/// point it at their own directory. Returns the taken lock, if any.
#[cfg(unix)]
fn try_prefetch_in(exe: &Path, requested: Option<&std::ffi::OsStr>, root: &Path) -> Option<PrefetchLock> {
    let layout = inspect_binary(exe).ok()?;
    let app_dir = validate_prefetch_dir(requested, root, &layout.config.identifier)?;
    let lazy = lazy_members(&layout.config);
    if lazy.is_empty() {
        return None;
    }
    let attempt = app_dir.file_name()?.to_str()?;
    let lock = take_prefetch_lock(root, &layout.config.identifier, attempt)?;
    lower_priority();
    let done = prefetch_members(&layout, exe, &app_dir, lazy);
    if done.is_ok() {
        // Written after the last member: a marker without a lock means the
        // members are done.
        let _ = fs::write(app_dir.join(PREFETCH_MARKER), b"");
    }
    Some(lock)
}

/// Accept CAXA_PREFETCH_APP only when it is the app dir of this very binary:
/// `<temp root>/apps/<identifier>/<attempt>`, a real directory, with no `..`
/// and no symlinked app dir on the way in. Anything else — including a value
/// that would resolve to the right place through a link or a `..` — is
/// rejected, and the prefetcher exits silently.
#[cfg(unix)]
fn validate_prefetch_dir(requested: Option<&std::ffi::OsStr>, root: &Path, identifier: &str) -> Option<PathBuf> {
    let requested = requested?;
    if requested.is_empty() {
        return None;
    }
    let requested = Path::new(requested);
    if !requested
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::RootDir))
    {
        return None;
    }
    let metadata = fs::symlink_metadata(requested).ok()?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return None;
    }
    let resolved = fs::canonicalize(requested).ok()?;
    let attempt = resolved.file_name()?.to_str()?;
    attempt.parse::<u32>().ok()?;
    let id_dir = resolved.parent()?;
    if id_dir.file_name().is_none_or(|n| n != identifier) {
        return None;
    }
    let apps_dir = id_dir.parent()?;
    if apps_dir.file_name().is_none_or(|n| n != "apps") {
        return None;
    }
    if apps_dir.parent()? != root {
        return None;
    }
    Some(resolved)
}

/// `locks/<id>/<attempt>.prefetch`: the pid of the running prefetcher.
#[cfg(unix)]
fn prefetch_lock_path(root: &Path, identifier: &str, attempt: &str) -> PathBuf {
    root.join("locks")
        .join(identifier)
        .join(format!("{attempt}{PREFETCH_LOCK_SUFFIX}"))
}

/// The prefetch lock file, removed when the guard is dropped — on success, on
/// error, and on the way out of the prefetcher.
#[cfg(unix)]
struct PrefetchLock(PathBuf);

#[cfg(unix)]
impl Drop for PrefetchLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Take the prefetch lock: a file created with `create_new` holding this
/// process's pid. A lock that is stale by mtime or whose writer is gone is
/// replaced; a live one is respected and nothing is prefetched.
#[cfg(unix)]
fn take_prefetch_lock(root: &Path, identifier: &str, attempt: &str) -> Option<PrefetchLock> {
    let lock = prefetch_lock_path(root, identifier, attempt);
    // One level at a time, never the root: a cache deleted since the app dir
    // was validated must not be recreated by a prefetcher.
    for dir in [root.join("locks"), root.join("locks").join(identifier)] {
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
    }
    for _ in 0..2 {
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&lock) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                if prefetch_lock_live(&lock) && !prefetch_lock_stale(&lock) {
                    return None;
                }
                // Stale or dead: replace it. A concurrent prefetcher that
                // wins the next create_new keeps us out.
                let _ = fs::remove_file(&lock);
                continue;
            }
            Err(_) => return None,
        };
        return file
            .write_all(process::id().to_string().as_bytes())
            .ok()
            .map(|_| PrefetchLock(lock));
    }
    None
}

/// Whether the lock's mtime is older than the staleness limit.
#[cfg(unix)]
fn prefetch_lock_stale(lock: &Path) -> bool {
    let Ok(modified) = fs::metadata(lock).and_then(|m| m.modified()) else {
        return true;
    };
    modified.elapsed().is_ok_and(|age| age >= PREFETCH_LOCK_STALE)
}

/// The pid a lock holds, or None when the content is not ours.
#[cfg(unix)]
fn lock_pid(lock: &Path) -> Option<i32> {
    fs::read_to_string(lock).ok()?.trim().parse::<i32>().ok()
}

/// Whether a process exists. An unreadable pid counts as gone; a pid owned by
/// another user (EPERM) counts as alive. Zero and negative values name process
/// groups for kill(2), never one process, so they count as gone too.
#[cfg(unix)]
fn process_alive(pid: Option<i32>) -> bool {
    let Some(pid) = pid.filter(|pid| *pid > 0) else {
        return false;
    };
    let live = unsafe { libc::kill(pid, 0) } == 0;
    live || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Whether the prefetch lock is held by a live process. A lock whose writer
/// died — a SIGKILLed prefetcher, for example — does not block a new one.
#[cfg(unix)]
fn prefetch_lock_live(lock: &Path) -> bool {
    process_alive(lock_pid(lock))
}

/// Run at nice 10 so the prefetcher never steals CPU from the app.
#[cfg(unix)]
fn lower_priority() {
    unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, PREFETCH_NICE) };
}

/// Spawn one detached prefetcher for `app_dir` before the app replaces this
/// process, when the layout has lazy members, CAXA_PREFETCH is not 0, the
/// app dir holds at least one placeholder of this identifier, and no live
/// prefetcher is running. Best effort by design: a failed spawn only delays
/// materialization to the member's first use.
#[cfg(unix)]
fn spawn_prefetcher(exe: &Path, layout: &Layout, app_dir: &Path) {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let lazy = lazy_members(&layout.config);
    if lazy.is_empty()
        || env::var_os(PREFETCH_DISABLE_ENV).is_some_and(|v| v == "0")
        || app_dir.join(PREFETCH_MARKER).exists()
        || !has_own_placeholders(app_dir, lazy, &layout.config.identifier)
    {
        return;
    }
    let Some(attempt) = app_dir.file_name().and_then(|s| s.to_str()) else {
        return;
    };
    let lock = prefetch_lock_path(&temp_root(), &layout.config.identifier, attempt);
    if lock.exists() && prefetch_lock_live(&lock) {
        return;
    }
    let mut cmd = Command::new(exe);
    // A separate process group outlives the app and is not killed with the
    // app's group; with the stdio gone nowhere, the prefetcher is silent.
    cmd.process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env(
            PREFETCH_ENV,
            fs::canonicalize(app_dir).unwrap_or_else(|_| app_dir.to_path_buf()),
        );
    let _ = cmd.spawn();
}

/// Whether any member path still holds a placeholder of this identifier.
/// Limited to the footer's member paths: a stat plus an 8-byte magic read per
/// member, and a bounded trailer parse only when the magic matches. Never a
/// directory walk, and not run at all when the marker exists.
#[cfg(unix)]
fn has_own_placeholders(app_dir: &Path, lazy: &[LazyMember], identifier: &str) -> bool {
    for member in lazy {
        let Ok(target) = safe_join(app_dir, Path::new(&member.path)) else {
            continue;
        };
        let Ok(mut file) = File::open(&target) else {
            continue;
        };
        let Ok(Some(placeholder)) = read_placeholder(&mut file) else {
            continue;
        };
        if placeholder.identifier == identifier {
            return true;
        }
    }
    false
}

/// Materialize every member that is still a placeholder of this binary, in
/// frame order, one at a time. Real files are skipped, and placeholders of
/// another identifier are left untouched. This binary is the only frame
/// candidate. Aligned frames decode in place, with no frame-sized buffer, and
/// on this one thread even when split: the prefetcher works in the background
/// and must not compete with the app. One pair of buffers, sized up front for
/// the largest pending frame that cannot, serves every other member, so their
/// peak is one frame's compressed and decoded bytes rather than whatever the
/// allocator keeps of earlier members.
#[cfg(unix)]
fn prefetch_members(layout: &Layout, exe: &Path, app_dir: &Path, lazy: &[LazyMember]) -> Result<()> {
    sweep_abandoned_temps(app_dir, lazy);
    let own_placeholder = |target: &Path, member: &LazyMember| -> Result<Option<Placeholder>> {
        let mut file = File::open(target).map_err(|e| format!("cannot open {}: {e}", target.display()))?;
        // None for a real file (the app got there first) and for a
        // placeholder that is not ours to replace.
        Ok(read_placeholder(&mut file)?.filter(|p| p.identifier == layout.config.identifier && p.path == member.path))
    };
    let mut pending = Vec::new();
    for member in lazy {
        let target = safe_join(app_dir, Path::new(&member.path))?;
        if let Some(placeholder) = own_placeholder(&target, member)? {
            pending.push((member, target, placeholder));
        }
    }
    let largest = |size: fn(&Placeholder) -> u64| {
        pending
            .iter()
            .filter(|(_, _, p)| in_place::data_offset(p.size, p.uncompressed_size).is_none())
            .map(|(_, _, p)| size(p))
            .max()
            .unwrap_or(0) as usize
    };
    let mut buffers = FrameBuffers {
        compressed: vec![0u8; largest(|p| p.compressed_size)],
        decoded: vec![0u8; largest(|p| p.uncompressed_size)],
    };
    for (member, target, _) in pending {
        // Checked again: the app may have materialized it meanwhile.
        let Some(placeholder) = own_placeholder(&target, member)? else {
            continue;
        };
        install_from(exe, &placeholder, &target, &mut buffers, 1)?;
    }
    Ok(())
}

/// Take an exclusive flock on `file`; with `try_only`, report whether it was
/// free instead of waiting. The lock goes away with the descriptor, including
/// when its holder is killed, and holds across PID namespaces sharing a cache.
#[cfg(unix)]
fn lock_exclusive(file: &File, try_only: bool) -> bool {
    use std::os::unix::io::AsRawFd;
    let operation = if try_only {
        libc::LOCK_EX | libc::LOCK_NB
    } else {
        libc::LOCK_EX
    };
    unsafe { libc::flock(file.as_raw_fd(), operation) == 0 }
}

/// Remove temp files that no live writer holds, next to the members: a killed
/// materialization cannot clean up after itself, but its rename target and
/// bytes are the same as ours, so nothing of value is lost. A writer holds an
/// flock on its temp file until the rename, and a sweep only removes a file
/// whose lock it can take and whose writer pid is gone. The pid alone is not
/// enough: a writer in another PID namespace sharing the cache looks dead.
#[cfg(unix)]
fn sweep_abandoned_temps(app_dir: &Path, lazy: &[LazyMember]) {
    for member in lazy {
        let Ok(target) = safe_join(app_dir, Path::new(&member.path)) else {
            continue;
        };
        let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else {
            continue;
        };
        let prefix = format!(".{}.caxa-", name.to_string_lossy());
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(rest) = file_name.to_str().and_then(|n| n.strip_prefix(&prefix)) else {
                continue;
            };
            let Some((pid, _nanos)) = rest.split_once('-') else {
                continue;
            };
            if process_alive(pid.parse::<i32>().ok()) {
                continue;
            }
            // Held while removing, so no writer can take it over meanwhile.
            let Ok(temp) = File::open(entry.path()) else {
                continue;
            };
            if lock_exclusive(&temp, true) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/// Decompress one frame with the declared uncompressed size as both the output
/// capacity and the acceptance check, then extract its tar entries. A split
/// frame (`parts`) decodes on parallel threads.
fn extract_frame(
    file: &mut File,
    payload_offset: u64,
    frame: &FrameEntry,
    parts: &[Part],
    dest: &Path,
    dirs: &DirCache,
) -> Result<()> {
    let offset = payload_offset
        .checked_add(frame.compressed_offset)
        .ok_or("frame offset overflow")?;
    if parts.len() > 1 {
        let mut decoded = vec![0u8; frame.uncompressed_size as usize];
        let (_, result) = decode_parts(file, offset, parts, &mut decoded, part_threads(), false)?;
        result?;
        return extract_frame_entries(&decoded, dest, dirs);
    }
    let mut compressed = vec![0u8; frame.compressed_size as usize];
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
    if !decoded.len().is_multiple_of(512) {
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
    // The prefetch variable is only meaningful to this binary's own prefetch
    // mode; the app must never see it, not even an inherited one.
    cmd.env_remove(PREFETCH_ENV);

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
