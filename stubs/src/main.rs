//! caxa runtime stub: locates the payload appended to this executable,
//! extracts it once into a cache directory and execs the configured command.
//!
//! Binary layout (unchanged, so the packager needs no changes):
//!   [stub]["\nCAXACAXACAXA\n"][payload][JSON footer][32-byte trailer]
//! Trailer: "CAXAIDX1" + LE u64 payload offset, payload size, footer size.
//! Binaries without a trailer fall back to the legacy separator scan.

use std::env;
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{self, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{sync_channel, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Deserialize;

const MAX_BUFFER_SIZE: u64 = 1024 * 1024;
const ARCHIVE_SEPARATOR: &[u8] = b"\nCAXACAXACAXA\n";
const TRAILER_MAGIC: &[u8] = b"CAXAIDX1";
const TRAILER_SIZE: u64 = 32;

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
}

struct Layout {
    config: Config,
    payload_offset: u64,
    payload_size: u64,
    /// Only populated for legacy (trailer-less) binaries.
    payload: Option<Vec<u8>>,
}

type Result<T> = std::result::Result<T, String>;

fn main() {
    let exe = env::current_exe().unwrap_or_else(|e| fatal(&format!("failed to find executable: {e}")));
    let layout = inspect_binary(&exe).unwrap_or_else(|e| fatal(&format!("binary corrupted: {e}")));
    let app_dir = prepare_application(&exe, &layout)
        .unwrap_or_else(|e| fatal(&format!("failed to prepare application: {e}")));
    let code = run(&layout.config, &app_dir).unwrap_or_else(|e| fatal(&format!("execution failed: {e}")));
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

fn inspect_binary(exe: &Path) -> Result<Layout> {
    let mut file = File::open(exe).map_err(|e| e.to_string())?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();

    if size >= TRAILER_SIZE {
        let mut trailer = [0u8; TRAILER_SIZE as usize];
        file.seek(SeekFrom::Start(size - TRAILER_SIZE)).map_err(|e| e.to_string())?;
        file.read_exact(&mut trailer).map_err(|e| e.to_string())?;
        if &trailer[..8] == TRAILER_MAGIC {
            let le = |r: std::ops::Range<usize>| u64::from_le_bytes(trailer[r].try_into().unwrap());
            let (payload_offset, payload_size, footer_size) = (le(8..16), le(16..24), le(24..32));
            let footer_offset = size
                .checked_sub(TRAILER_SIZE)
                .and_then(|s| s.checked_sub(footer_size))
                .ok_or("invalid trailer offsets")?;
            if payload_offset.checked_add(payload_size).map_or(true, |end| end > footer_offset) {
                return Err("payload overlaps footer".into());
            }
            let mut footer = vec![0u8; footer_size as usize];
            file.seek(SeekFrom::Start(footer_offset)).map_err(|e| e.to_string())?;
            file.read_exact(&mut footer).map_err(|e| format!("failed to read footer: {e}"))?;
            let config: Config =
                serde_json::from_slice(&footer).map_err(|e| format!("invalid footer json: {e}"))?;
            return Ok(Layout { config, payload_offset, payload_size, payload: None });
        }
    }

    let data = fs::read(exe).map_err(|e| e.to_string())?;
    let (config, start, end) = parse_binary(&data)?;
    Ok(Layout {
        config,
        payload_offset: start as u64,
        payload_size: (end - start) as u64,
        payload: Some(data[start..end].to_vec()),
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
    // Payloads are built with long-distance matching; allow the largest window
    // libzstd supports (ZSTD_WINDOWLOG_MAX: 31 on 64-bit, 30 on 32-bit).
    let window_log_max = if cfg!(target_pointer_width = "64") { 31 } else { 30 };
    d.window_log_max(window_log_max).map_err(|e| e.to_string())?;
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
    let input: Box<dyn Read> = match &layout.payload {
        Some(p) => Box::new(io::Cursor::new(p.as_slice())),
        None => {
            let mut f = File::open(exe).map_err(|e| e.to_string())?;
            f.seek(SeekFrom::Start(layout.payload_offset)).map_err(|e| e.to_string())?;
            Box::new(BufReader::with_capacity(256 * 1024, f.take(layout.payload_size)))
        }
    };
    extract_from(decompressor(&layout.config.compression, input)?, dest)
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
                        if tx.send(Job { dest: target, data, mode }).is_err() {
                            return Ok(()); // pool died; its error is in `failure`
                        }
                    } else {
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
                        io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
                    }
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

fn run(config: &Config, app_dir: &Path) -> Result<i32> {
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
        let key = if cfg!(target_os = "macos") { "DYLD_LIBRARY_PATH" } else { "LD_LIBRARY_PATH" };
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
