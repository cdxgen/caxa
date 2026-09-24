// Unit tests for the caxa runtime stub.

use super::*;
use std::collections::BTreeMap;
use std::io::{self, Write};

fn tarball(files: &BTreeMap<&str, Vec<u8>>) -> Vec<u8> {
    let mut b = tar::Builder::new(Vec::new());
    for (name, content) in files {
        let mut h = tar::Header::new_gnu();
        h.set_size(content.len() as u64);
        h.set_mode(0o600);
        h.set_cksum();
        b.append_data(&mut h, name, content.as_slice()).unwrap();
    }
    b.into_inner().unwrap()
}

fn compress(tar: &[u8], compression: &str) -> Vec<u8> {
    match compression {
        "gzip" => {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
            e.write_all(tar).unwrap();
            e.finish().unwrap()
        }
        "zstd" => zstd::encode_all(tar, 19).unwrap(),
        other => panic!("unsupported compression: {other}"),
    }
}

fn layout(payload: Vec<u8>, compression: &str) -> Layout {
    Layout {
        config: Config { compression: compression.into(), ..Default::default() },
        payload_offset: 0,
        payload_size: payload.len() as u64,
        payload: Some(payload),
        frames: Vec::new(),
    }
}

#[test]
fn parse_legacy_binary() {
    let mut bin = b"some-binary-code-here".to_vec();
    bin.extend_from_slice(ARCHIVE_SEPARATOR);
    bin.extend_from_slice(b"mock-compressed-data");
    bin.push(b'\n');
    bin.extend_from_slice(br#"{"identifier":"test-id","command":["node","index.js"]}"#);
    let (config, start, end) = parse_binary(&bin).unwrap();
    assert_eq!(config.identifier, "test-id");
    assert_eq!(&bin[start..end], b"mock-compressed-data");
}

#[test]
fn inspect_trailer_and_stream_extract() {
    let files = BTreeMap::from([("index.js", b"console.log('ok')".to_vec())]);
    let payload = compress(&tarball(&files), "gzip");
    let footer = br#"{"identifier":"trailer-test","command":["node","index.js"],"compression":"gzip"}"#;

    let mut bin = b"stub-bytes".to_vec();
    bin.extend_from_slice(ARCHIVE_SEPARATOR);
    let offset = bin.len() as u64;
    bin.extend_from_slice(&payload);
    bin.extend_from_slice(footer);
    bin.extend_from_slice(TRAILER_MAGIC);
    bin.extend_from_slice(&offset.to_le_bytes());
    bin.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bin.extend_from_slice(&(footer.len() as u64).to_le_bytes());

    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("bin");
    fs::write(&exe, &bin).unwrap();

    let l = inspect_binary(&exe).unwrap();
    assert_eq!(l.config.identifier, "trailer-test");
    assert_eq!(l.payload_offset, offset);
    assert_eq!(l.payload_size, payload.len() as u64);
    assert!(l.payload.is_none(), "trailer layout must not load payload eagerly");

    let out = dir.path().join("out");
    extract(&l, &exe, &out).unwrap();
    assert_eq!(fs::read(out.join("index.js")).unwrap(), b"console.log('ok')");
}

#[test]
fn parallel_and_large_files() {
    let small = b"small-file".to_vec();
    let large: Vec<u8> = (0..(1024 * 1024 + 100)).map(|i| (i * 31 % 251) as u8).collect();
    let files = BTreeMap::from([
        ("small.txt", small.clone()),
        ("subdir/test.txt", small.clone()),
        ("large.bin", large.clone()),
    ]);
    let dir = tempfile::tempdir().unwrap();
    extract(&layout(compress(&tarball(&files), "gzip"), "gzip"), Path::new(""), dir.path()).unwrap();
    assert_eq!(fs::read(dir.path().join("small.txt")).unwrap(), small);
    assert_eq!(fs::read(dir.path().join("subdir/test.txt")).unwrap(), small);
    assert_eq!(fs::read(dir.path().join("large.bin")).unwrap(), large);
}

#[test]
fn zip_slip_rejected() {
    // tar::Builder refuses `..`, so write the header name directly.
    let mut h = tar::Header::new_gnu();
    h.as_old_mut().name[..19].copy_from_slice(b"../../../etc/passwd");
    h.set_size(4);
    h.set_mode(0o600);
    h.set_cksum();
    let mut raw = h.as_bytes().to_vec();
    raw.extend_from_slice(b"root");
    raw.resize(raw.len() + 508 + 1024, 0);

    let dir = tempfile::tempdir().unwrap();
    let err = extract(&layout(compress(&raw, "gzip"), "gzip"), Path::new(""), dir.path()).unwrap_err();
    assert!(err.contains("illegal file path"), "got: {err}");
}

#[test]
fn zstd_payload() {
    let files = BTreeMap::from([("index.js", b"console.log('zstd-ok')".to_vec())]);
    let dir = tempfile::tempdir().unwrap();
    extract(&layout(compress(&tarball(&files), "zstd"), "zstd"), Path::new(""), dir.path()).unwrap();
    assert_eq!(fs::read(dir.path().join("index.js")).unwrap(), b"console.log('zstd-ok')");
}

#[test]
fn zstd_long_window_payload() {
    // The packager uses long-distance matching with a 128 MiB window (--long=27).
    // Decoders must accept it (libzstd's default limit is 2^27).
    let files = BTreeMap::from([("index.js", b"console.log('long-ok')".to_vec())]);
    let mut enc = zstd::stream::write::Encoder::new(Vec::new(), 19).unwrap();
    enc.long_distance_matching(true).unwrap();
    enc.window_log(27).unwrap();
    enc.include_contentsize(false).unwrap();
    enc.write_all(&tarball(&files)).unwrap();
    let payload = enc.finish().unwrap();
    let dir = tempfile::tempdir().unwrap();
    extract(&layout(payload, "zstd"), Path::new(""), dir.path()).unwrap();
    assert_eq!(fs::read(dir.path().join("index.js")).unwrap(), b"console.log('long-ok')");
}

#[test]
fn unsupported_compression() {
    let err = extract(&layout(vec![], "brotli"), Path::new(""), Path::new("/nonexistent")).unwrap_err();
    assert!(err.contains("unsupported payload compression: brotli"));
}

#[test]
fn substitute_placeholder() {
    assert_eq!(substitute("{{caxa}}/node", "/a"), "/a/node");
    assert_eq!(substitute("{{ caxa }}/x/{{caxa}}", "/a"), "/a/x//a");
    assert_eq!(substitute("{{other}}", "/a"), "{{other}}");
    assert_eq!(substitute("plain", "/a"), "plain");
}

// --- v2 (CAXAIDX2) ---

/// One whole tar entry as its own byte range, so frames can be assembled at
/// entry boundaries exactly like the packager does.
fn entry_tar(name: &str, content: &[u8]) -> Vec<u8> {
    let mut h = tar::Header::new_gnu();
    h.set_size(content.len() as u64);
    h.set_mode(0o600);
    h.set_cksum();
    let mut b = tar::Builder::new(Vec::new());
    b.append_data(&mut h, name, content).unwrap();
    entry_bytes(b)
}

fn dir_tar(name: &str) -> Vec<u8> {
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(tar::EntryType::Directory);
    h.set_size(0);
    h.set_mode(0o755);
    h.set_cksum();
    let mut b = tar::Builder::new(Vec::new());
    b.append_data(&mut h, name, io::empty()).unwrap();
    entry_bytes(b)
}

fn symlink_tar(name: &str, target: &str) -> Vec<u8> {
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(tar::EntryType::Symlink);
    h.set_size(0);
    h.set_mode(0o777);
    h.set_link_name(Path::new(target)).unwrap();
    h.set_cksum();
    let mut b = tar::Builder::new(Vec::new());
    b.append_data(&mut h, name, io::empty()).unwrap();
    entry_bytes(b)
}

fn zip_slip_entry_tar() -> Vec<u8> {
    // tar::Builder refuses `..`, so write the header name directly.
    let mut h = tar::Header::new_gnu();
    h.as_old_mut().name[..19].copy_from_slice(b"../../../etc/passwd");
    h.set_size(4);
    h.set_mode(0o600);
    h.set_cksum();
    let mut raw = h.as_bytes().to_vec();
    raw.extend_from_slice(b"root");
    raw.resize(raw.len() + 508, 0);
    raw
}

/// Builder output without the end-of-archive blocks, so entries can be
/// concatenated into frames like the packager does.
fn entry_bytes(b: tar::Builder<Vec<u8>>) -> Vec<u8> {
    let mut raw = b.into_inner().unwrap();
    raw.truncate(raw.len() - 1024);
    raw
}

struct V2Fixture {
    bytes: Vec<u8>,
    payload_offset: u64,
    payload_size: u64,
    index_offset: u64,
    index_size: u64,
    footer_size: u64,
}

/// A v2 binary from pre-compressed frames of the given uncompressed sizes,
/// with a hand-set index, so tests can assemble valid and corrupt layouts.
fn build_v2_custom(frames: &[(&[u8], u64)], index: Vec<u8>, compression: &str) -> V2Fixture {
    let mut payload = Vec::new();
    for (compressed, _) in frames {
        payload.extend_from_slice(compressed);
    }
    let footer = format!(
        r#"{{"identifier":"v2-test","command":["node","index.js"],"compression":"{compression}"}}"#
    );

    let mut bytes = b"stub-bytes".to_vec();
    bytes.extend_from_slice(ARCHIVE_SEPARATOR);
    let payload_offset = bytes.len() as u64;
    bytes.extend_from_slice(&payload);
    let index_offset = bytes.len() as u64;
    bytes.extend_from_slice(&index);
    let footer_offset = bytes.len() as u64;
    bytes.extend_from_slice(footer.as_bytes());
    bytes.extend_from_slice(TRAILER2_MAGIC);
    bytes.extend_from_slice(&payload_offset.to_le_bytes());
    bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&(footer.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&index_offset.to_le_bytes());
    bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
    let _ = footer_offset;

    V2Fixture {
        bytes,
        payload_offset,
        payload_size: payload.len() as u64,
        index_offset,
        index_size: index.len() as u64,
        footer_size: footer.len() as u64,
    }
}

/// Compress whole tar chunks as independent frames with a consistent index.
fn build_v2(frame_tars: &[Vec<u8>], compression: &str) -> V2Fixture {
    let frames: Vec<(Vec<u8>, u64)> = frame_tars
        .iter()
        .map(|tar| match compression {
            "zstd" => (zstd::encode_all(tar.as_slice(), 19).unwrap(), tar.len() as u64),
            other => panic!("unsupported compression: {other}"),
        })
        .collect();
    let refs: Vec<(&[u8], u64)> = frames.iter().map(|(c, n)| (c.as_slice(), *n)).collect();
    let mut index = Vec::new();
    let mut offset = 0u64;
    for (compressed, uncompressed) in &refs {
        index.extend_from_slice(&offset.to_le_bytes());
        index.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
        index.extend_from_slice(&uncompressed.to_le_bytes());
        offset += compressed.len() as u64;
    }
    build_v2_custom(&refs, index, compression)
}

fn inspect(bytes: &[u8]) -> (tempfile::TempDir, PathBuf, Layout) {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("bin");
    fs::write(&exe, bytes).unwrap();
    let l = inspect_binary(&exe).unwrap();
    (dir, exe, l)
}

fn extract_fixture(fixture: &V2Fixture) -> Result<()> {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("bin");
    fs::write(&exe, &fixture.bytes).unwrap();
    let l = inspect_binary(&exe)?;
    extract(&l, &exe, &dir.path().join("out"))
}

/// Rewrites trailer fields; footer size always stays the real one so the
/// footer lookup keeps working.
fn set_trailer2(fixture: &mut V2Fixture, payload_size: u64, index_offset: u64, index_size: u64) {
    let trailer_at = fixture.bytes.len() - TRAILER2_SIZE as usize;
    let mut trailer = Vec::new();
    trailer.extend_from_slice(TRAILER2_MAGIC);
    trailer.extend_from_slice(&fixture.payload_offset.to_le_bytes());
    trailer.extend_from_slice(&payload_size.to_le_bytes());
    trailer.extend_from_slice(&fixture.footer_size.to_le_bytes());
    trailer.extend_from_slice(&index_offset.to_le_bytes());
    trailer.extend_from_slice(&index_size.to_le_bytes());
    fixture.bytes.splice(trailer_at.., trailer);
}

#[test]
fn v2_round_trip() {
    let big: Vec<u8> = (0..(1024 * 1024 + 100)).map(|i| (i * 31 % 251) as u8).collect();
    let frames = vec![
        [dir_tar("app"), entry_tar("app/bin.js", b"console.log('v2')")].concat(),
        [entry_tar("app/data.bin", &big), entry_tar("app/sub/x.txt", b"x")].concat(),
        [dir_tar("empty-dir"), entry_tar("top.txt", b"top")].concat(),
    ];
    let fixture = build_v2(&frames, "zstd");
    let (dir, exe, l) = inspect(&fixture.bytes);
    assert_eq!(l.frames.len(), 3);
    let out = dir.path().join("out");
    extract(&l, &exe, &out).unwrap();
    assert_eq!(fs::read(out.join("app/bin.js")).unwrap(), b"console.log('v2')");
    assert_eq!(fs::read(out.join("app/data.bin")).unwrap(), big);
    assert_eq!(fs::read(out.join("app/sub/x.txt")).unwrap(), b"x");
    assert_eq!(fs::read(out.join("top.txt")).unwrap(), b"top");
    assert!(out.join("empty-dir").is_dir());
}

#[test]
fn v1_trailer_still_decodes_framed_payload() {
    // Step 1 payloads: concatenated frames with a v1 trailer and no index.
    let frames = vec![
        entry_tar("one.txt", b"1"),
        entry_tar("two.txt", b"22"),
        entry_tar("three.txt", b"333"),
    ];
    let mut payload = Vec::new();
    for tar in &frames {
        payload.extend(zstd::encode_all(tar.as_slice(), 19).unwrap());
    }
    let footer = br#"{"identifier":"framed-v1","command":["node","index.js"],"compression":"zstd"}"#;
    let mut bin = b"stub-bytes".to_vec();
    bin.extend_from_slice(ARCHIVE_SEPARATOR);
    let offset = bin.len() as u64;
    bin.extend_from_slice(&payload);
    bin.extend_from_slice(footer);
    bin.extend_from_slice(TRAILER_MAGIC);
    bin.extend_from_slice(&offset.to_le_bytes());
    bin.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bin.extend_from_slice(&(footer.len() as u64).to_le_bytes());

    let (dir, exe, l) = inspect(&bin);
    assert!(l.frames.is_empty(), "v1 trailer must not build a frame index");
    let out = dir.path().join("out");
    extract(&l, &exe, &out).unwrap();
    assert_eq!(fs::read(out.join("one.txt")).unwrap(), b"1");
    assert_eq!(fs::read(out.join("two.txt")).unwrap(), b"22");
    assert_eq!(fs::read(out.join("three.txt")).unwrap(), b"333");
}

#[test]
fn v2_directories_and_symlinks_across_frames() {
    // Frame 0 creates the directory and a symlink; frame 1 fills them. Frame
    // order at extraction time is arbitrary, so parents must be created by
    // whichever frame needs them first.
    let frames = vec![
        [
            dir_tar("app"),
            symlink_tar("app/latest", "app/versions/current"),
        ]
        .concat(),
        [
            dir_tar("app/versions"),
            dir_tar("app/versions/current"),
            entry_tar("app/versions/current/app.js", b"v1"),
        ]
        .concat(),
        [entry_tar("app/other.js", b"v2")].concat(),
    ];
    let fixture = build_v2(&frames, "zstd");
    let (dir, exe, l) = inspect(&fixture.bytes);
    let out = dir.path().join("out");
    extract(&l, &exe, &out).unwrap();
    assert_eq!(fs::read(out.join("app/versions/current/app.js")).unwrap(), b"v1");
    assert_eq!(fs::read(out.join("app/other.js")).unwrap(), b"v2");
    assert!(
        fs::symlink_metadata(out.join("app/latest")).unwrap().file_type().is_symlink(),
        "app/latest must stay a symlink"
    );
    assert_eq!(
        fs::read_link(out.join("app/latest")).unwrap(),
        Path::new("app/versions/current")
    );
}

#[test]
fn v2_zip_slip_in_later_frame_rejected() {
    let frames = vec![entry_tar("ok.txt", b"ok"), zip_slip_entry_tar()];
    let fixture = build_v2(&frames, "zstd");
    let (dir, exe, l) = inspect(&fixture.bytes);
    let out = dir.path().join("out");
    let err = extract(&l, &exe, &out).unwrap_err();
    assert!(err.contains("illegal file path"), "got: {err}");
    assert!(
        !dir.path().join("etc/passwd").exists(),
        "nothing may be written outside dest"
    );
}

#[test]
fn v2_preserves_file_modes() {
    let mut h = tar::Header::new_gnu();
    h.set_size(b"#!/bin/sh".len() as u64);
    h.set_mode(0o755);
    h.set_cksum();
    let mut b = tar::Builder::new(Vec::new());
    b.append_data(&mut h, "script.sh", b"#!/bin/sh".as_slice()).unwrap();
    let fixture = build_v2(&[entry_bytes(b)], "zstd");
    let (dir, exe, l) = inspect(&fixture.bytes);
    let out = dir.path().join("out");
    extract(&l, &exe, &out).unwrap();
    assert_eq!(fs::read(out.join("script.sh")).unwrap(), b"#!/bin/sh");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(out.join("script.sh")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }
}

#[test]
fn v2_large_window_frame() {
    // The packager compresses with long-distance matching (window log up to
    // 27); decoders must accept it on every target, including 32-bit.
    let tar = entry_tar("index.js", b"console.log('window')");
    let mut enc = zstd::stream::write::Encoder::new(Vec::new(), 19).unwrap();
    enc.long_distance_matching(true).unwrap();
    enc.window_log(27).unwrap();
    enc.write_all(&tar).unwrap();
    let frame = enc.finish().unwrap();
    let fixture = build_v2_custom(&[(&frame, tar.len() as u64)], build_index(&[&frame], &[tar.len() as u64]), "zstd");
    let (dir, exe, l) = inspect(&fixture.bytes);
    let out = dir.path().join("out");
    extract(&l, &exe, &out).unwrap();
    assert_eq!(fs::read(out.join("index.js")).unwrap(), b"console.log('window')");
}

/// Index bytes for the given compressed frame lengths and uncompressed sizes.
fn build_index(compressed: &[&[u8]], uncompressed: &[u64]) -> Vec<u8> {
    let mut index = Vec::new();
    let mut offset = 0u64;
    for (c, u) in compressed.iter().zip(uncompressed) {
        index.extend_from_slice(&offset.to_le_bytes());
        index.extend_from_slice(&(c.len() as u64).to_le_bytes());
        index.extend_from_slice(&u.to_le_bytes());
        offset += c.len() as u64;
    }
    index
}

#[test]
fn v2_rejects_frame_outside_payload() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a")], "zstd");
    let entry_at = fixture.index_offset as usize;
    fixture.bytes[entry_at + 8..entry_at + 16]
        .copy_from_slice(&(fixture.payload_size + 1).to_le_bytes());
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("frame outside payload"), "got: {err}");
}

#[test]
fn v2_rejects_index_not_covering_payload() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a"), entry_tar("b.txt", b"b")], "zstd");
    // Drop the last index entry: the payload is now only partly covered.
    let (ps, io_, is_) = (fixture.payload_size, fixture.index_offset, fixture.index_size - INDEX_ENTRY_SIZE);
    set_trailer2(&mut fixture, ps, io_, is_);
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("does not cover the payload"), "got: {err}");
}

#[test]
fn v2_rejects_overlapping_frames() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a"), entry_tar("b.txt", b"b")], "zstd");
    // Point the second frame back at the first frame's offset.
    let entry_at = fixture.index_offset as usize + INDEX_ENTRY_SIZE as usize;
    fixture.bytes[entry_at..entry_at + 8].copy_from_slice(&0u64.to_le_bytes());
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("frames are not contiguous"), "got: {err}");
}

#[test]
fn v2_rejects_index_size_overflow() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a"), entry_tar("b.txt", b"b")], "zstd");
    // The second frame's compressed size overflows u64 with its offset added.
    let entry_at = fixture.index_offset as usize + INDEX_ENTRY_SIZE as usize;
    fixture.bytes[entry_at + 8..entry_at + 16].copy_from_slice(&u64::MAX.to_le_bytes());
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("frame size overflow"), "got: {err}");
}

#[test]
fn v2_rejects_wrong_uncompressed_size() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a")], "zstd");
    let entry_at = fixture.index_offset as usize;
    fixture.bytes[entry_at + 16..entry_at + 24].copy_from_slice(&9999u64.to_le_bytes());
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("expected 9999"), "got: {err}");
}

#[test]
fn v2_rejects_decompression_bomb() {
    // Declared uncompressed size smaller than the real content: the output
    // buffer is too small and decoding must fail instead of truncating.
    let tar = entry_tar("a.txt", b"a");
    let mut fixture = build_v2(&[tar.clone()], "zstd");
    let entry_at = fixture.index_offset as usize;
    fixture.bytes[entry_at + 16..entry_at + 24].copy_from_slice(&1u64.to_le_bytes());
    let _ = tar;
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("failed to decode frame"), "got: {err}");
}

#[test]
fn v2_rejects_corrupted_frame_bytes() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a")], "zstd");
    // Flip bytes inside the compressed frame; every size check passes but the
    // zstd frame will not decode.
    let start = fixture.payload_offset as usize + 8;
    let end = fixture.payload_offset as usize + fixture.payload_size as usize;
    for b in &mut fixture.bytes[start..end] {
        *b ^= 0xa5;
    }
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("failed to decode frame"), "got: {err}");
}

#[test]
fn v2_rejects_truncated_binary() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a")], "zstd");
    // Cut the file mid-payload: the trailer is gone, the legacy scan must
    // fail cleanly instead of extracting something.
    fixture.bytes.truncate(fixture.payload_offset as usize + fixture.payload_size as usize / 2);
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("invalid footer json") || err.contains("footer not found"), "got: {err}");
}

#[test]
fn v2_rejects_too_many_frames() {
    // A real oversized index (65537 entries of zeros) so the trailer stays
    // consistent and the frame-count cap is what rejects it.
    let frame = zstd::encode_all(entry_tar("a.txt", b"a").as_slice(), 19).unwrap();
    let index = vec![0u8; ((MAX_FRAMES + 1) * INDEX_ENTRY_SIZE) as usize];
    let fixture = build_v2_custom(&[(&frame, 1024)], index, "zstd");
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("too many frames"), "got: {err}");
}

#[test]
fn v2_rejects_index_overlapping_footer() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a")], "zstd");
    let (ps, io_, is_) = (fixture.payload_size, fixture.index_offset + 1_000_000, fixture.index_size);
    set_trailer2(&mut fixture, ps, io_, is_);
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("index overlaps footer"), "got: {err}");
}

#[test]
fn v2_rejects_payload_overlapping_index() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a")], "zstd");
    let (ps, io_, is_) = (u64::MAX - fixture.payload_offset, fixture.index_offset, fixture.index_size);
    set_trailer2(&mut fixture, ps, io_, is_);
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("payload overlaps index"), "got: {err}");
}

#[test]
fn v2_rejects_non_zstd_compression() {
    let tar = entry_tar("a.txt", b"a");
    let fixture = build_v2_custom(&[(&tar, tar.len() as u64)], build_index(&[&tar], &[tar.len() as u64]), "raw");
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("v2 payload requires zstd"), "got: {err}");
}

#[test]
fn v2_rejects_unaligned_frame_content() {
    let mut padded = entry_tar("a.txt", b"a");
    padded.extend_from_slice(&[0u8; 100]); // trailing garbage after the entry
    let fixture = build_v2(&[padded], "zstd");
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("tar block boundary"), "got: {err}");
}

