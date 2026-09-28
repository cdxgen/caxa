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
        config: Config {
            compression: compression.into(),
            ..Default::default()
        },
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
    extract(
        &layout(compress(&tarball(&files), "gzip"), "gzip"),
        Path::new(""),
        dir.path(),
    )
    .unwrap();
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
    extract(
        &layout(compress(&tarball(&files), "zstd"), "zstd"),
        Path::new(""),
        dir.path(),
    )
    .unwrap();
    assert_eq!(
        fs::read(dir.path().join("index.js")).unwrap(),
        b"console.log('zstd-ok')"
    );
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
    assert_eq!(
        fs::read(dir.path().join("index.js")).unwrap(),
        b"console.log('long-ok')"
    );
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
    let footer = format!(r#"{{"identifier":"v2-test","command":["node","index.js"],"compression":"{compression}"}}"#);

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
        [dir_tar("app"), symlink_tar("app/latest", "app/versions/current")].concat(),
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
        fs::symlink_metadata(out.join("app/latest"))
            .unwrap()
            .file_type()
            .is_symlink(),
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
    let fixture = build_v2_custom(
        &[(&frame, tar.len() as u64)],
        build_index(&[&frame], &[tar.len() as u64]),
        "zstd",
    );
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
    fixture.bytes[entry_at + 8..entry_at + 16].copy_from_slice(&(fixture.payload_size + 1).to_le_bytes());
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("frame outside payload"), "got: {err}");
}

#[test]
fn v2_rejects_index_not_covering_payload() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a"), entry_tar("b.txt", b"b")], "zstd");
    // Drop the last index entry: the payload is now only partly covered.
    let (ps, io_, is_) = (
        fixture.payload_size,
        fixture.index_offset,
        fixture.index_size - INDEX_ENTRY_SIZE,
    );
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
    let mut fixture = build_v2(std::slice::from_ref(&tar), "zstd");
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
    fixture
        .bytes
        .truncate(fixture.payload_offset as usize + fixture.payload_size as usize / 2);
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(
        err.contains("invalid footer json") || err.contains("footer not found"),
        "got: {err}"
    );
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
    let (ps, io_, is_) = (
        fixture.payload_size,
        fixture.index_offset + 1_000_000,
        fixture.index_size,
    );
    set_trailer2(&mut fixture, ps, io_, is_);
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("index overlaps footer"), "got: {err}");
}

#[test]
fn v2_rejects_payload_overlapping_index() {
    let mut fixture = build_v2(&[entry_tar("a.txt", b"a")], "zstd");
    let (ps, io_, is_) = (
        u64::MAX - fixture.payload_offset,
        fixture.index_offset,
        fixture.index_size,
    );
    set_trailer2(&mut fixture, ps, io_, is_);
    let err = extract_fixture(&fixture).unwrap_err();
    assert!(err.contains("payload overlaps index"), "got: {err}");
}

#[test]
fn v2_rejects_non_zstd_compression() {
    let tar = entry_tar("a.txt", b"a");
    let fixture = build_v2_custom(
        &[(&tar, tar.len() as u64)],
        build_index(&[&tar], &[tar.len() as u64]),
        "raw",
    );
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

// --- lazy members and placeholders ---

/// A v2 binary whose frames are `hot` followed by one frame per lazy member,
/// with a footer `lazy` array built from the real compressed frames. Returns
/// the binary bytes and the lazy entries' JSON so tests can tamper with them.
fn build_lazy(hot: &[Vec<u8>], lazy: &[(&str, Vec<u8>, u32)], identifier: &str) -> Vec<u8> {
    build_lazy_with(hot, lazy, identifier, |compressed| compressed)
}

/// `build_lazy` with each lazy frame's compressed bytes passed through
/// `mangle`; the index and sha256 describe the mangled bytes.
fn build_lazy_with(
    hot: &[Vec<u8>],
    lazy: &[(&str, Vec<u8>, u32)],
    identifier: &str,
    mangle: impl Fn(Vec<u8>) -> Vec<u8>,
) -> Vec<u8> {
    let mut frames: Vec<(Vec<u8>, u64)> = hot
        .iter()
        .map(|tar| (zstd::encode_all(tar.as_slice(), 19).unwrap(), tar.len() as u64))
        .collect();
    let mut members = Vec::new();
    for (name, tar, mode) in lazy {
        let compressed = mangle(zstd::encode_all(tar.as_slice(), 19).unwrap());
        members.push(format!(
            r#"{{"path":"{name}","frame":{},"mode":{mode},"size":{},"sha256":"{}"}}"#,
            frames.len(),
            tar_member_size(tar),
            sha256_hex(&compressed)
        ));
        frames.push((compressed, tar.len() as u64));
    }
    let footer = format!(
        r#"{{"identifier":"{identifier}","command":["node","index.js"],"compression":"zstd","lazy":[{}]}}"#,
        members.join(",")
    );
    v2_bytes(&frames, &footer)
}

/// Size of the first entry in a tar chunk (its regular-file header).
fn tar_member_size(tar: &[u8]) -> u64 {
    let mut archive = tar::Archive::new(Cursor::new(tar));
    let entry = archive.entries().unwrap().next().unwrap().unwrap();
    entry.size()
}

fn v2_bytes(frames: &[(Vec<u8>, u64)], footer: &str) -> Vec<u8> {
    let mut bytes = b"stub-bytes".to_vec();
    bytes.extend_from_slice(ARCHIVE_SEPARATOR);
    let payload_offset = bytes.len() as u64;
    let mut index = Vec::new();
    let mut offset = 0u64;
    for (compressed, uncompressed) in frames {
        index.extend_from_slice(&offset.to_le_bytes());
        index.extend_from_slice(&(compressed.len() as u64).to_le_bytes());
        index.extend_from_slice(&uncompressed.to_le_bytes());
        offset += compressed.len() as u64;
        bytes.extend_from_slice(compressed);
    }
    let index_offset = bytes.len() as u64;
    bytes.extend_from_slice(&index);
    bytes.extend_from_slice(footer.as_bytes());
    bytes.extend_from_slice(TRAILER2_MAGIC);
    bytes.extend_from_slice(&payload_offset.to_le_bytes());
    bytes.extend_from_slice(&offset.to_le_bytes());
    bytes.extend_from_slice(&(footer.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&index_offset.to_le_bytes());
    bytes.extend_from_slice(&(index.len() as u64).to_le_bytes());
    bytes
}

fn exec_entry_tar(name: &str, content: &[u8]) -> Vec<u8> {
    let mut h = tar::Header::new_gnu();
    h.set_size(content.len() as u64);
    h.set_mode(0o755);
    h.set_cksum();
    let mut b = tar::Builder::new(Vec::new());
    b.append_data(&mut h, name, content).unwrap();
    entry_bytes(b)
}

const TOOL: &[u8] = b"#!/bin/sh\necho lazy-tool\n";

/// Extract a lazy fixture and return (tempdir, exe, app dir).
fn extract_lazy(bytes: &[u8]) -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("bin");
    fs::write(&exe, bytes).unwrap();
    let l = inspect_binary(&exe).unwrap();
    let out = dir.path().join("out");
    extract(&l, &exe, &out).unwrap();
    (dir, exe, out)
}

fn placeholder_at(path: &Path) -> Result<Option<Placeholder>> {
    read_placeholder(&mut File::open(path).unwrap())
}

#[test]
fn footer_ignores_unknown_fields() {
    // Stubs before lazy members parse this footer the same way; the compat
    // design relies on Config not denying unknown fields.
    let config: Config = serde_json::from_str(
        r#"{"identifier":"x","command":["a"],"compression":"zstd","futureField":{"a":1},"lazy":[]}"#,
    )
    .unwrap();
    assert_eq!(config.identifier, "x");
}

#[cfg(unix)]
#[test]
fn lazy_cold_start_writes_placeholder_and_materializes() {
    let bytes = build_lazy(
        &[entry_tar("index.js", b"hot")],
        &[("bin/tool", exec_entry_tar("bin/tool", TOOL), 0o755)],
        "lazy-id",
    );
    let (_dir, exe, out) = extract_lazy(&bytes);
    assert_eq!(fs::read(out.join("index.js")).unwrap(), b"hot");

    // The placeholder is the stub bytes plus a trailer, with the member's mode.
    let placeholder_bytes = fs::read(out.join("bin/tool")).unwrap();
    assert!(placeholder_bytes.starts_with(b"stub-bytes"));
    assert!(placeholder_bytes.ends_with(PLACEHOLDER_MAGIC));
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(out.join("bin/tool")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }
    let p = placeholder_at(&out.join("bin/tool")).unwrap().unwrap();
    assert_eq!(p.identifier, "lazy-id");
    assert_eq!(p.path, "bin/tool");
    assert_eq!(PathBuf::from(&p.source), fs::canonicalize(&exe).unwrap());

    let target = placeholder_target(&out.join("bin/tool"), &p.path).unwrap();
    materialize_into(std::slice::from_ref(&exe), &p, &target).unwrap();
    assert_eq!(fs::read(out.join("bin/tool")).unwrap(), TOOL);
    assert_eq!(
        fs::read_dir(out.join("bin")).unwrap().count(),
        1,
        "no temp file may be left next to the member"
    );
}

#[cfg(unix)]
#[test]
fn lazy_long_member_name_round_trips() {
    // Names over 100 bytes travel in a GNU long-name record in the same frame.
    let name = format!("bin/{}tool", "long-".repeat(25));
    let bytes = build_lazy(
        &[entry_tar("index.js", b"hot")],
        &[(&name, exec_entry_tar(&name, TOOL), 0o755)],
        "long-id",
    );
    let (_dir, exe, out) = extract_lazy(&bytes);
    let p = placeholder_at(&out.join(&name)).unwrap().unwrap();
    materialize_into(&[exe], &p, &out.join(&name)).unwrap();
    assert_eq!(fs::read(out.join(&name)).unwrap(), TOOL);
}

#[test]
fn placeholder_rejects_malformed_trailers() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p");
    let check = |bytes: &[u8]| {
        fs::write(&path, bytes).unwrap();
        placeholder_at(&path)
    };

    // Bad magic: not a placeholder at all.
    assert!(check(b"stub-bytes{}\x02\0\0\0\0\0\0\0CAXALZY2").unwrap().is_none());
    // Truncated: the magic without a length field.
    let err = check(b"xCAXALZY1").unwrap_err();
    assert!(err.contains("truncated"), "got: {err}");
    // Oversized JSON length, and a length larger than the file.
    let mut big = b"stub".to_vec();
    big.extend_from_slice(&(MAX_PLACEHOLDER_JSON + 1).to_le_bytes());
    big.extend_from_slice(PLACEHOLDER_MAGIC);
    assert!(check(&big).unwrap_err().contains("out of bounds"));
    let mut past = b"stub".to_vec();
    past.extend_from_slice(&1000u64.to_le_bytes());
    past.extend_from_slice(PLACEHOLDER_MAGIC);
    assert!(check(&past).unwrap_err().contains("out of bounds"));
    // Malformed JSON.
    assert!(check(&placeholder_bytes(b"{not json"))
        .unwrap_err()
        .contains("invalid placeholder json"));
}

fn placeholder_bytes(json: &[u8]) -> Vec<u8> {
    let mut bytes = b"stub-bytes".to_vec();
    bytes.extend_from_slice(json);
    bytes.extend_from_slice(&(json.len() as u64).to_le_bytes());
    bytes.extend_from_slice(PLACEHOLDER_MAGIC);
    bytes
}

fn valid_placeholder() -> Placeholder {
    Placeholder {
        identifier: "id".into(),
        path: "bin/tool".into(),
        frame: 1,
        offset: 0,
        compressed_size: 10,
        uncompressed_size: 1024,
        sha256: "0".repeat(64),
        mode: 0o755,
        size: 10,
        source: "/nonexistent".into(),
    }
}

#[test]
fn placeholder_rejects_bad_fields() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p");
    let check = |edit: &dyn Fn(&mut Placeholder)| {
        let mut p = valid_placeholder();
        edit(&mut p);
        fs::write(&path, placeholder_bytes(&serde_json::to_vec(&p).unwrap())).unwrap();
        placeholder_at(&path)
    };
    assert!(check(&|_| {}).unwrap().is_some());
    for (edit, want) in [
        (
            &(|p: &mut Placeholder| p.path = "../escape".into()) as &dyn Fn(&mut Placeholder),
            "illegal lazy member path",
        ),
        (
            &|p: &mut Placeholder| p.path = "bin/../../escape".into(),
            "illegal lazy member path",
        ),
        (
            &|p: &mut Placeholder| p.path = "/etc/passwd".into(),
            "illegal lazy member path",
        ),
        (
            &|p: &mut Placeholder| p.path = String::new(),
            "illegal lazy member path",
        ),
        (&|p: &mut Placeholder| p.sha256 = "zz".into(), "invalid sha256"),
        (
            &|p: &mut Placeholder| p.identifier = String::new(),
            "without identifier",
        ),
        (
            &|p: &mut Placeholder| p.compressed_size = u64::MAX,
            "compressed size out of bounds",
        ),
        (
            &|p: &mut Placeholder| p.uncompressed_size = MAX_FRAME_UNCOMPRESSED + 1,
            "uncompressed size out of bounds",
        ),
        (&|p: &mut Placeholder| p.size = 4096, "member size out of bounds"),
    ] {
        let err = check(edit).unwrap_err();
        assert!(err.contains(want), "want {want}, got: {err}");
    }
}

#[test]
fn placeholder_detected_before_legacy_scan() {
    // A placeholder is a stub copy, so it contains the separator; followed by
    // something footer-like the legacy scan would accept it. The placeholder
    // check must win.
    let mut bytes = b"stub".to_vec();
    bytes.extend_from_slice(ARCHIVE_SEPARATOR);
    bytes.extend_from_slice(b"junk\n");
    bytes.extend_from_slice(br#"{"identifier":"legacy","command":["x"]}"#);
    assert!(parse_binary(&bytes).is_ok(), "fixture must look like a legacy binary");
    let json = serde_json::to_vec(&valid_placeholder()).unwrap();
    bytes.extend_from_slice(&json);
    bytes.extend_from_slice(&(json.len() as u64).to_le_bytes());
    bytes.extend_from_slice(PLACEHOLDER_MAGIC);
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p");
    fs::write(&path, &bytes).unwrap();
    let p = placeholder_at(&path).unwrap().expect("placeholder must be detected");
    assert_eq!(p.identifier, "id");
}

#[cfg(target_os = "linux")]
#[test]
fn self_placeholder_reads_the_running_file_on_linux() {
    // /proc/self/exe is the file this process was started from, so a member
    // renamed over the path meanwhile is never mistaken for it. Here the path
    // holds a placeholder but the running file is the test binary.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("p");
    fs::write(
        &path,
        placeholder_bytes(&serde_json::to_vec(&valid_placeholder()).unwrap()),
    )
    .unwrap();
    assert!(placeholder_at(&path).unwrap().is_some());
    assert!(read_self_placeholder(&path).unwrap().is_none());
}

/// A placeholder for the fixture's lazy member, read back from extraction.
#[cfg(unix)]
/// A lazy binary with one member, extracted: the dir, the binary, the
/// member's placeholder and its path.
fn lazy_fixture(lazy_tar: Vec<u8>, name: &str, identifier: &str) -> (tempfile::TempDir, PathBuf, Placeholder, PathBuf) {
    let bytes = build_lazy(&[entry_tar("index.js", b"hot")], &[(name, lazy_tar, 0o755)], identifier);
    let (dir, exe, out) = extract_lazy(&bytes);
    let target = out.join(name);
    let p = placeholder_at(&target).unwrap().unwrap();
    (dir, exe, p, target)
}

#[cfg(unix)]
/// A failed materialization leaves the placeholder and no temp file.
fn assert_untouched(target: &Path) {
    assert!(placeholder_at(target).unwrap().is_some(), "the placeholder must stay");
    let temps: Vec<_> = fs::read_dir(target.parent().unwrap())
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.file_name())
        .collect();
    assert!(temps.is_empty(), "temp files left behind: {temps:?}");
}

#[cfg(unix)]
#[test]
fn materialize_rejects_sha256_mismatch() {
    let (_dir, exe, mut p, target) = lazy_fixture(exec_entry_tar("bin/tool", TOOL), "bin/tool", "sha-id");
    p.sha256 = "0".repeat(64);
    let err = materialize_into(&[exe], &p, &target).unwrap_err();
    assert_untouched(&target);
    assert!(err.contains("sha256 mismatch"), "got: {err}");
}

#[cfg(unix)]
#[test]
fn materialize_rejects_identifier_mismatch() {
    let (_dir, exe, mut p, target) = lazy_fixture(exec_entry_tar("bin/tool", TOOL), "bin/tool", "real-id");
    p.identifier = "other-id".into();
    let err = materialize_into(&[exe], &p, &target).unwrap_err();
    assert_untouched(&target);
    assert!(err.contains("identifier is 'real-id'"), "got: {err}");
}

#[cfg(unix)]
#[test]
fn materialize_skips_stale_candidate() {
    // A stale CAXA_EXECUTABLE (another binary, other identifier) is skipped
    // and the next candidate is used.
    let (_d1, other, _, _) = lazy_fixture(exec_entry_tar("bin/tool", TOOL), "bin/tool", "other-id");
    let (_d2, exe, p, target) = lazy_fixture(exec_entry_tar("bin/tool", TOOL), "bin/tool", "this-id");
    materialize_into(&[other, exe], &p, &target).unwrap();
    assert_eq!(fs::read(&target).unwrap(), TOOL);
}

#[cfg(unix)]
#[test]
fn materialize_rejects_non_caxa_candidate() {
    let (dir, _exe, p, target) = lazy_fixture(exec_entry_tar("bin/tool", TOOL), "bin/tool", "id");
    let junk = dir.path().join("junk");
    fs::write(&junk, b"not a caxa binary").unwrap();
    let err = materialize_into(&[junk], &p, &target).unwrap_err();
    assert_untouched(&target);
    assert!(err.contains("not a v2 caxa binary"), "got: {err}");
}

#[cfg(unix)]
#[test]
fn materialize_rejects_wrong_entry_name() {
    // The footer and placeholder say bin/tool, the frame holds bin/other.
    let (_dir, exe, p, target) = lazy_fixture(exec_entry_tar("bin/other", TOOL), "bin/tool", "name-id");
    let err = materialize_into(&[exe], &p, &target).unwrap_err();
    assert_untouched(&target);
    assert!(err.contains("frame entry is bin/other"), "got: {err}");
}

#[cfg(unix)]
#[test]
fn materialize_rejects_two_entries() {
    let two = [exec_entry_tar("bin/tool", TOOL), exec_entry_tar("bin/tool2", TOOL)].concat();
    let (_dir, exe, p, target) = lazy_fixture(two, "bin/tool", "two-id");
    let err = materialize_into(&[exe], &p, &target).unwrap_err();
    assert_untouched(&target);
    assert!(err.contains("more than one entry"), "got: {err}");
}

#[cfg(unix)]
#[test]
fn materialize_rejects_frame_index_mismatch() {
    let (_dir, exe, mut p, target) = lazy_fixture(exec_entry_tar("bin/tool", TOOL), "bin/tool", "idx-id");
    p.uncompressed_size += 512;
    let err = materialize_into(&[exe], &p, &target).unwrap_err();
    assert_untouched(&target);
    assert!(err.contains("frame index entry differs"), "got: {err}");
}

// --- in-place decode (Unix) ---

/// Prepend a pax header to one entry's tar bytes (GNU long-name records
/// included) whose `comment` record pads the data to a 64 KiB-aligned offset,
/// as the packager lays out lazy frames.
fn align_frame(entry: &[u8]) -> Vec<u8> {
    const ALIGN: usize = 64 * 1024;
    let mut archive = tar::Archive::new(Cursor::new(entry));
    let before_data = archive.entries().unwrap().next().unwrap().unwrap().raw_file_position() as usize;
    let mut pax_len = (ALIGN - (512 + before_data) % ALIGN) % ALIGN;
    if pax_len < 32 {
        pax_len += ALIGN;
    }
    let digits = pax_len.to_string().len();
    let record = format!("{pax_len} comment={}\n", "0".repeat(pax_len - digits - 10));
    assert_eq!(record.len(), pax_len);
    let mut header = tar::Header::new_ustar();
    header.set_path("PaxHeader").unwrap();
    header.set_size(pax_len as u64);
    header.set_entry_type(tar::EntryType::XHeader);
    header.set_mode(0o644);
    header.set_cksum();
    [header.as_bytes().as_slice(), record.as_bytes(), entry].concat()
}

fn aligned_entry_tar(name: &str, content: &[u8]) -> Vec<u8> {
    align_frame(&exec_entry_tar(name, content))
}

/// Incompressible bytes, several pages of them.
fn big_member() -> Vec<u8> {
    (0..300_000u32)
        .map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8)
        .collect()
}

/// Decode `p`'s frame in place from `exe` into `target`, as install_from does.
#[cfg(unix)]
fn install_in_place(exe: &Path, p: &Placeholder, target: &Path) -> Result<bool> {
    let h = in_place::data_offset(p.size, p.uncompressed_size).expect("an aligned frame");
    let (mut source, offset) = open_source_frame(exe, p)?;
    in_place::install(
        &mut source,
        offset,
        &in_place::Expected::member(p),
        h,
        target,
        &mut |_| Ok(target.to_path_buf()),
    )
}

#[cfg(unix)]
#[test]
fn in_place_decodes_an_aligned_member() {
    use std::os::unix::fs::PermissionsExt;
    let content = big_member();
    let (_dir, exe, p, target) = lazy_fixture(aligned_entry_tar("bin/tool", &content), "bin/tool", "ip-id");
    assert_eq!(in_place::data_offset(p.size, p.uncompressed_size), Some(64 * 1024));
    assert!(
        install_in_place(&exe, &p, &target).unwrap(),
        "the in-place path must be taken"
    );
    assert_eq!(fs::read(&target).unwrap(), content);
    assert_eq!(fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755);
    assert_eq!(
        fs::read_dir(target.parent().unwrap()).unwrap().count(),
        1,
        "no temp file"
    );
}

#[cfg(unix)]
#[test]
fn in_place_long_name_round_trips() {
    // A GNU long-name record sits between the pax header and the entry.
    let name = format!("bin/{}tool", "long-".repeat(25));
    let (_dir, exe, p, target) = lazy_fixture(aligned_entry_tar(&name, TOOL), &name, "ip-long");
    assert!(install_in_place(&exe, &p, &target).unwrap());
    assert_eq!(fs::read(&target).unwrap(), TOOL);
}

#[cfg(unix)]
#[test]
fn in_place_only_for_aligned_frames() {
    // The #15 layout (data right after the header) takes the buffer path.
    let (_d, _exe, p, _t) = lazy_fixture(exec_entry_tar("bin/tool", TOOL), "bin/tool", "ip-plain");
    assert_eq!(in_place::data_offset(p.size, p.uncompressed_size), None);
    // Empty members never decode in place.
    let (_d, _exe, p, _t) = lazy_fixture(aligned_entry_tar("bin/tool", b""), "bin/tool", "ip-empty");
    assert_eq!(in_place::data_offset(p.size, p.uncompressed_size), None);
}

#[cfg(unix)]
#[test]
fn in_place_rejects_a_frame_that_differs_from_its_placeholder() {
    let content = big_member();
    // The entry name differs from the placeholder's path.
    let (_d, exe, p, target) = lazy_fixture(aligned_entry_tar("bin/other", &content), "bin/tool", "ip-name");
    let err = install_in_place(&exe, &p, &target).unwrap_err();
    assert!(err.contains("frame entry is bin/other"), "got: {err}");
    assert_untouched(&target);
    // One byte shorter than the entry: same padded size, so the same data
    // offset, and the tar header disagrees.
    let (_d, exe, mut p, target) = lazy_fixture(aligned_entry_tar("bin/tool", &content), "bin/tool", "ip-size");
    p.size -= 1;
    let err = install_in_place(&exe, &p, &target).unwrap_err();
    assert!(err.contains("expected 299999"), "got: {err}");
    assert_untouched(&target);
    // A frame that is not the one the placeholder hashed.
    let (_d, exe, mut p, target) = lazy_fixture(aligned_entry_tar("bin/tool", &content), "bin/tool", "ip-sha");
    p.sha256 = "0".repeat(64);
    let err = install_in_place(&exe, &p, &target).unwrap_err();
    assert!(err.contains("sha256 mismatch"), "got: {err}");
    assert_untouched(&target);
}

#[cfg(unix)]
#[test]
fn in_place_rejects_a_truncated_frame() {
    // The index and sha256 describe the truncated bytes, so only the decode
    // can tell.
    let content = big_member();
    let bytes = build_lazy_with(
        &[entry_tar("index.js", b"hot")],
        &[("bin/tool", aligned_entry_tar("bin/tool", &content), 0o755)],
        "ip-trunc",
        |mut compressed| {
            compressed.truncate(compressed.len() - 64);
            compressed
        },
    );
    let (_dir, exe, out) = extract_lazy(&bytes);
    let target = out.join("bin/tool");
    let p = placeholder_at(&target).unwrap().unwrap();
    let err = install_in_place(&exe, &p, &target).unwrap_err();
    assert!(err.contains("frame decoded to"), "got: {err}");
    assert_untouched(&target);
}

#[cfg(unix)]
#[test]
fn in_place_rejects_zip_slip_and_non_regular_entries() {
    let content = big_member();
    // An entry named ../tool: the raw name bytes, which tar::Builder refuses.
    let mut slip = exec_entry_tar("bin/tool", &content);
    slip[..100].fill(0);
    slip[..7].copy_from_slice(b"../tool");
    let mut header = tar::Header::from_byte_slice(&slip[..512]).clone();
    header.set_cksum();
    slip[..512].copy_from_slice(header.as_bytes());
    let (_d, exe, p, target) = lazy_fixture(align_frame(&slip), "bin/tool", "ip-slip");
    let err = install_in_place(&exe, &p, &target).unwrap_err();
    assert!(err.contains("not bin/tool"), "got: {err}");
    assert_untouched(&target);
    // A FIFO entry with data behind it.
    let mut fifo = tar::Header::new_gnu();
    fifo.set_entry_type(tar::EntryType::Fifo);
    fifo.set_size(content.len() as u64);
    fifo.set_mode(0o755);
    fifo.set_cksum();
    let mut b = tar::Builder::new(Vec::new());
    b.append_data(&mut fifo, "bin/tool", content.as_slice()).unwrap();
    let (_d, exe, p, target) = lazy_fixture(align_frame(&entry_bytes(b)), "bin/tool", "ip-fifo");
    let err = install_in_place(&exe, &p, &target).unwrap_err();
    assert!(err.contains("not a regular file"), "got: {err}");
    assert_untouched(&target);
}

// --- in-place decode of hot frames (Unix) ---

/// A v2 binary whose hot frames are `hot`, with a footer `aligned` list.
fn build_aligned(hot: &[Vec<u8>], aligned: &str) -> Vec<u8> {
    let frames: Vec<(Vec<u8>, u64)> = hot
        .iter()
        .map(|tar| (zstd::encode_all(tar.as_slice(), 19).unwrap(), tar.len() as u64))
        .collect();
    let footer = format!(
        r#"{{"identifier":"hot-id","command":["node","index.js"],"compression":"zstd","aligned":[{aligned}]}}"#
    );
    v2_bytes(&frames, &footer)
}

#[cfg(unix)]
/// Extract `bytes`; the dir, the result and the app dir.
fn extract_bytes(bytes: &[u8]) -> (tempfile::TempDir, Result<()>, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("bin");
    fs::write(&exe, bytes).unwrap();
    let out = dir.path().join("out");
    let result = inspect_binary(&exe).and_then(|l| extract(&l, &exe, &out));
    (dir, result, out)
}

#[cfg(unix)]
/// Temp files (`.{name}.caxa-{pid}-{nanos}`) anywhere below `dir`.
fn dot_files(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return found;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') && name.contains(".caxa-") {
            found.push(path.clone());
        }
        if path.is_dir() {
            found.extend(dot_files(&path));
        }
    }
    found
}

#[cfg(unix)]
#[test]
fn hot_aligned_frame_extracts_in_place() {
    use std::os::unix::fs::PermissionsExt;
    let big = big_member();
    let bytes = build_aligned(
        &[
            entry_tar("index.js", b"hot"),
            aligned_entry_tar("node_modules/.bin/node", &big),
            entry_tar("after.js", b"after"),
        ],
        &format!(r#"{{"frame":1,"size":{}}}"#, big.len()),
    );
    let (_dir, result, out) = extract_bytes(&bytes);
    result.unwrap();
    assert_eq!(fs::read(out.join("node_modules/.bin/node")).unwrap(), big);
    let mode = fs::metadata(out.join("node_modules/.bin/node"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o111, 0o111, "the entry's exec bits: {mode:o}");
    assert_eq!(fs::read(out.join("index.js")).unwrap(), b"hot");
    assert_eq!(fs::read(out.join("after.js")).unwrap(), b"after");
    assert_eq!(dot_files(&out), Vec::<PathBuf>::new(), "no temp file may remain");

    // The frame took the in-place path, not the buffered fallback.
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("bin");
    fs::write(&exe, &bytes).unwrap();
    let layout = inspect_binary(&exe).unwrap();
    assert!(in_place_frames(&layout).contains_key(&1));
    let dest = dir.path().join("direct");
    let done = extract_frame_in_place(
        &mut File::open(&exe).unwrap(),
        layout.payload_offset,
        &layout.frames[1],
        1,
        big.len() as u64,
        &dest,
        &DirCache::default(),
    )
    .unwrap();
    assert!(done, "the in-place path must be taken");
    assert_eq!(fs::read(dest.join("node_modules/.bin/node")).unwrap(), big);
}

#[cfg(unix)]
#[test]
fn hot_aligned_frames_fall_back_or_fail_cleanly() {
    let big = big_member();
    // Without a footer entry, and with an entry whose size does not give an
    // aligned offset, the frame takes the buffered path.
    for aligned in [String::new(), format!(r#"{{"frame":1,"size":{}}}"#, big.len() - 600)] {
        let bytes = build_aligned(
            &[entry_tar("index.js", b"hot"), aligned_entry_tar("bin/big", &big)],
            &aligned,
        );
        let (_dir, result, out) = extract_bytes(&bytes);
        result.unwrap();
        assert_eq!(fs::read(out.join("bin/big")).unwrap(), big, "aligned = {aligned}");
    }
    // A size one byte off, at the same data offset: the entry disagrees.
    let bytes = build_aligned(
        &[entry_tar("index.js", b"hot"), aligned_entry_tar("bin/big", &big)],
        &format!(r#"{{"frame":1,"size":{}}}"#, big.len() - 1),
    );
    let (_dir, result, out) = extract_bytes(&bytes);
    let err = result.unwrap_err();
    assert!(err.contains("expected 299999"), "got: {err}");
    assert_eq!(dot_files(&out), Vec::<PathBuf>::new(), "no temp file may remain");
    assert!(!out.join("bin/big").exists());
    // An entry that escapes the app dir.
    let mut slip = exec_entry_tar("bin/big", &big);
    slip[..100].fill(0);
    slip[..6].copy_from_slice(b"../big");
    let mut header = tar::Header::from_byte_slice(&slip[..512]).clone();
    header.set_cksum();
    slip[..512].copy_from_slice(header.as_bytes());
    let bytes = build_aligned(
        &[entry_tar("index.js", b"hot"), align_frame(&slip)],
        &format!(r#"{{"frame":1,"size":{}}}"#, big.len()),
    );
    let (dir, result, out) = extract_bytes(&bytes);
    assert!(result.is_err());
    assert!(!dir.path().join("big").exists(), "nothing may land outside the app dir");
    assert_eq!(dot_files(&out), Vec::<PathBuf>::new(), "no temp file may remain");
}

#[test]
fn inspect_rejects_bad_aligned_footer() {
    let hot = [
        entry_tar("index.js", b"hot"),
        aligned_entry_tar("bin/big", &big_member()),
    ];
    for (aligned, expected) in [
        (r#"{"frame":7,"size":1}"#, "is missing"),
        (r#"{"frame":1,"size":1},{"frame":1,"size":1}"#, "listed twice"),
        (r#"{"frame":1,"size":99999999}"#, "smaller than its file"),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("bin");
        fs::write(&exe, build_aligned(&hot, aligned)).unwrap();
        let err = inspect_binary(&exe).err().expect("a bad footer must be rejected");
        assert!(err.contains(expected), "{aligned}: got {err}");
    }
}

#[cfg(unix)]
#[test]
fn in_place_frames_extract_eagerly_like_any_frame() {
    // Old stubs and Windows extract lazy frames with the tar reader, which
    // ignores the pax comment.
    let content = big_member();
    let frame = aligned_entry_tar("bin/tool", &content);
    let dir = tempfile::tempdir().unwrap();
    let mut archive = tar::Archive::new(Cursor::new(&frame));
    archive.unpack(dir.path()).unwrap();
    assert_eq!(fs::read(dir.path().join("bin/tool")).unwrap(), content);
    assert_eq!(fs::read_dir(dir.path().join("bin")).unwrap().count(), 1);
}

#[test]
fn inspect_rejects_bad_lazy_footer() {
    let frames = vec![
        (zstd::encode_all(entry_tar("a", b"a").as_slice(), 19).unwrap(), 1024u64),
        (
            zstd::encode_all(exec_entry_tar("t", TOOL).as_slice(), 19).unwrap(),
            1024u64,
        ),
    ];
    let sha = "0".repeat(64);
    for (lazy, want) in [
        (
            format!(r#"[{{"path":"t","frame":5,"mode":493,"size":1,"sha256":"{sha}"}}]"#),
            "missing frame",
        ),
        (
            format!(
                r#"[{{"path":"t","frame":1,"mode":493,"size":1,"sha256":"{sha}"}},{{"path":"u","frame":1,"mode":493,"size":1,"sha256":"{sha}"}}]"#
            ),
            "shares frame",
        ),
        (
            format!(r#"[{{"path":"../t","frame":1,"mode":493,"size":1,"sha256":"{sha}"}}]"#),
            "illegal lazy member path",
        ),
        (
            r#"[{"path":"t","frame":1,"mode":493,"size":1,"sha256":"x"}]"#.to_string(),
            "invalid sha256",
        ),
    ] {
        let footer = format!(r#"{{"identifier":"x","command":["a"],"compression":"zstd","lazy":{lazy}}}"#);
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("bin");
        fs::write(&exe, v2_bytes(&frames, &footer)).unwrap();
        let err = inspect_binary(&exe).err().unwrap();
        assert!(err.contains(want), "want {want}, got: {err}");
    }
}

#[test]
fn placeholder_target_must_end_with_member_path() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("bin")).unwrap();
    fs::write(dir.path().join("bin/tool"), b"x").unwrap();
    assert!(placeholder_target(&dir.path().join("bin/tool"), "bin/tool").is_ok());
    let err = placeholder_target(&dir.path().join("bin/tool"), "other/tool").unwrap_err();
    assert!(err.contains("not at its member path"), "got: {err}");
}

#[cfg(unix)]
#[test]
fn replaced_member_only_matches_lazy_member_paths() {
    let bytes = build_lazy(
        &[entry_tar("index.js", b"hot")],
        &[("bin/tool", exec_entry_tar("bin/tool", TOOL), 0o755)],
        "race-id",
    );
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("caxa-bin");
    fs::write(&exe, &bytes).unwrap();
    let app = dir.path().join("apps/race-id/0");
    extract(&inspect_binary(&exe).unwrap(), &exe, &app).unwrap();
    let member = app.join("bin/tool");
    // The race: a concurrent first run renamed the real member over the
    // placeholder this process was started from.
    fs::write(&member, TOOL).unwrap();
    assert_eq!(replaced_member(&member, &exe), Some(fs::canonicalize(&member).unwrap()));

    // Not a lazy member path, another identifier's app dir, no apps dir, and
    // a source that is not a caxa binary: never exec'd.
    assert_eq!(replaced_member(&app.join("index.js"), &exe), None);
    for other in ["apps/other-id/0/bin/tool", "elsewhere/race-id/0/bin/tool"] {
        let other = dir.path().join(other);
        fs::create_dir_all(other.parent().unwrap()).unwrap();
        fs::write(&other, TOOL).unwrap();
        assert_eq!(replaced_member(&other, &exe), None, "{}", other.display());
    }
    assert_eq!(replaced_member(&member, &member), None);
}

#[cfg(windows)]
#[test]
fn lazy_frames_extract_eagerly_on_windows() {
    let bytes = build_lazy(
        &[entry_tar("index.js", b"hot")],
        &[("bin/tool", exec_entry_tar("bin/tool", TOOL), 0o755)],
        "win-id",
    );
    let (_dir, _exe, out) = extract_lazy(&bytes);
    assert_eq!(fs::read(out.join("bin/tool")).unwrap(), TOOL);
}

#[test]
fn eager_order_is_largest_first_without_lazy_frames() {
    let frame = |u| FrameEntry {
        compressed_offset: 0,
        compressed_size: 1,
        uncompressed_size: u,
    };
    let frames = vec![frame(10), frame(50), frame(10), frame(80), frame(50)];
    assert_eq!(eager_order(&frames, &[]), vec![3, 1, 4, 0, 2]);
    let lazy = [LazyMember {
        path: "x".into(),
        frame: 3,
        mode: 0o755,
        size: 1,
        sha256: String::new(),
    }];
    assert_eq!(eager_order(&frames, &lazy), vec![1, 4, 0, 2]);
}

// --- background prefetch ---

#[cfg(unix)]
mod prefetch {
    use super::*;
    use std::ffi::OsStr;
    use std::os::unix::fs::PermissionsExt;
    use std::time::SystemTime;

    /// A pid that cannot exist: pid_max is far below i32::MAX everywhere.
    const DEAD_PID: i32 = i32::MAX - 1;

    /// Extract a lazy fixture into `<root>/apps/<identifier>/0`, the app dir
    /// a prefetcher would be pointed at. `root` must be canonical.
    fn fixture(root: &Path, work: &Path, identifier: &str, lazy: &[(&str, Vec<u8>, u32)]) -> (PathBuf, PathBuf) {
        let bytes = build_lazy(&[entry_tar("index.js", b"hot")], lazy, identifier);
        let exe = work.join("caxa-bin");
        fs::write(&exe, bytes).unwrap();
        let app_dir = root.join("apps").join(identifier).join("0");
        fs::create_dir_all(&app_dir).unwrap();
        extract(&inspect_binary(&exe).unwrap(), &exe, &app_dir).unwrap();
        (exe, app_dir)
    }

    fn backdate(path: &Path) {
        let file = OpenOptions::new().write(true).open(path).unwrap();
        file.set_times(std::fs::FileTimes::new().set_modified(SystemTime::UNIX_EPOCH))
            .unwrap();
    }

    fn os(p: &Path) -> &OsStr {
        p.as_os_str()
    }

    #[test]
    fn prefetch_dir_validation() {
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let id = "pf-id";
        let work = tempfile::tempdir().unwrap();
        let (_exe, app_dir) = fixture(
            &root,
            work.path(),
            id,
            &[("bin/tool", exec_entry_tar("bin/tool", TOOL), 0o755)],
        );

        // The app dir of this identifier, exactly as the protocol lays it out.
        assert_eq!(
            validate_prefetch_dir(Some(os(&app_dir)), &root, id),
            Some(fs::canonicalize(&app_dir).unwrap())
        );
        // Unset or empty.
        assert_eq!(validate_prefetch_dir(None, &root, id), None);
        assert_eq!(validate_prefetch_dir(Some(OsStr::new("")), &root, id), None);
        // Outside the temp root.
        let other = tempfile::tempdir().unwrap();
        let other_app = other.path().join("apps").join(id).join("0");
        fs::create_dir_all(&other_app).unwrap();
        assert_eq!(validate_prefetch_dir(Some(os(&other_app)), &root, id), None);
        // Wrong identifier, even at an otherwise perfect path.
        let wrong = root.join("apps").join("other-id").join("0");
        fs::create_dir_all(&wrong).unwrap();
        assert_eq!(validate_prefetch_dir(Some(os(&wrong)), &root, id), None);
        // A `..` in the value, although it would resolve to the right place.
        let dots = app_dir.join("..").join("0");
        assert_eq!(validate_prefetch_dir(Some(os(&dots)), &root, id), None);
        // A symlinked app dir, although it points at the real one.
        let link = root.join("apps").join(id).join("1");
        symlink(&app_dir, &link).unwrap();
        assert_eq!(validate_prefetch_dir(Some(os(&link)), &root, id), None);
        // A file instead of a directory.
        let file_dir = root.join("apps").join(id).join("2");
        fs::write(&file_dir, b"x").unwrap();
        assert_eq!(validate_prefetch_dir(Some(os(&file_dir)), &root, id), None);
    }

    #[test]
    fn prefetch_lock_liveness() {
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let path = prefetch_lock_path(&root, "lock-id", "0");

        // A fresh lock with a live writer is respected, and untouched.
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, process::id().to_string()).unwrap();
        assert!(take_prefetch_lock(&root, "lock-id", "0").is_none());
        assert_eq!(fs::read_to_string(&path).unwrap(), process::id().to_string());

        // A stale lock is replaced even when the writer looks alive.
        backdate(&path);
        let taken = take_prefetch_lock(&root, "lock-id", "0").expect("stale lock must be replaced");
        assert_eq!(fs::read_to_string(&path).unwrap(), process::id().to_string());
        drop(taken);
        assert!(!path.exists(), "dropping the guard removes the lock");

        // A dead writer's lock is replaced while it is still fresh.
        fs::write(&path, DEAD_PID.to_string()).unwrap();
        let taken = take_prefetch_lock(&root, "lock-id", "0").expect("dead writer's lock must be replaced");
        assert_eq!(fs::read_to_string(&path).unwrap(), process::id().to_string());
        drop(taken);

        // A lock whose content is not a pid counts as dead.
        fs::write(&path, b"garbage").unwrap();
        let taken = take_prefetch_lock(&root, "lock-id", "0").expect("unreadable lock must be replaced");
        drop(taken);
        assert!(!path.exists());
    }

    #[test]
    fn prefetch_materializes_only_own_placeholders() {
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let lazy = [
            ("bin/ours", exec_entry_tar("bin/ours", TOOL), 0o755),
            ("bin/second", exec_entry_tar("bin/second", TOOL), 0o755),
            ("bin/foreign", exec_entry_tar("bin/foreign", TOOL), 0o755),
        ];
        let (exe, app_dir) = fixture(&root, work.path(), "pf-own", &lazy);
        // The app got to bin/ours first: a real file with other bytes.
        fs::write(app_dir.join("bin/ours"), b"already-real").unwrap();
        // A placeholder of another identifier at bin/foreign.
        let foreign = Placeholder {
            identifier: "other-id".into(),
            path: "bin/foreign".into(),
            frame: 9,
            offset: 0,
            compressed_size: 10,
            uncompressed_size: 1024,
            sha256: "0".repeat(64),
            mode: 0o755,
            size: 10,
            source: String::new(),
        };
        fs::write(
            app_dir.join("bin/foreign"),
            placeholder_bytes(&serde_json::to_vec(&foreign).unwrap()),
        )
        .unwrap();

        let lock = try_prefetch_in(&exe, Some(os(&app_dir)), &root).expect("the prefetch must run");
        drop(lock);

        assert_eq!(
            fs::read(app_dir.join("bin/ours")).unwrap(),
            b"already-real",
            "a real file must not be replaced"
        );
        assert_eq!(fs::read(app_dir.join("bin/second")).unwrap(), TOOL);
        assert_eq!(
            placeholder_at(&app_dir.join("bin/foreign"))
                .unwrap()
                .unwrap()
                .identifier,
            "other-id",
            "a foreign placeholder must be left untouched"
        );
        assert!(
            app_dir.join(".caxa-prefetched").exists(),
            "the marker is written after the last member"
        );
        assert!(!prefetch_lock_path(&root, "pf-own", "0").exists(), "no lock remains");
        let leftovers: Vec<_> = fs::read_dir(app_dir.join("bin"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .filter(|n| n.to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
    }

    #[test]
    fn prefetch_error_removes_lock_and_leaves_the_rest() {
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let lazy = [
            ("bin/first", exec_entry_tar("bin/first", TOOL), 0o755),
            ("bin/second", exec_entry_tar("bin/second", TOOL), 0o755),
        ];
        let (exe, app_dir) = fixture(&root, work.path(), "pf-err", &lazy);
        // Corrupt the first member's frame inside the binary, after the
        // placeholders were written: the sha256 no longer matches.
        let p = placeholder_at(&app_dir.join("bin/first")).unwrap().unwrap();
        let layout = inspect_binary(&exe).unwrap();
        let mut bytes = fs::read(&exe).unwrap();
        let at = (layout.payload_offset + p.offset + 16) as usize;
        bytes[at] ^= 0xa5;
        fs::write(&exe, bytes).unwrap();

        let lock = try_prefetch_in(&exe, Some(os(&app_dir)), &root).expect("the lock is taken before the failure");
        drop(lock);

        assert!(
            !app_dir.join(".caxa-prefetched").exists(),
            "a failed prefetch writes no marker"
        );
        assert!(
            !prefetch_lock_path(&root, "pf-err", "0").exists(),
            "the lock is removed on error"
        );
        for member in ["bin/first", "bin/second"] {
            assert_eq!(
                placeholder_at(&app_dir.join(member)).unwrap().unwrap().identifier,
                "pf-err",
                "{member} must still be a placeholder"
            );
        }
        let leftovers: Vec<_> = fs::read_dir(app_dir.join("bin"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .filter(|n| n.to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
    }

    #[test]
    fn prefetch_missing_app_dir_is_silent() {
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let (exe, app_dir) = fixture(
            &root,
            work.path(),
            "pf-gone",
            &[("bin/tool", exec_entry_tar("bin/tool", TOOL), 0o755)],
        );
        // The cache vanished before the prefetcher validated its argument.
        fs::remove_dir_all(&root).unwrap();
        assert!(try_prefetch_in(&exe, Some(os(&app_dir)), &root).is_none());
        assert!(!root.exists(), "nothing may be recreated under the deleted root");
    }

    #[test]
    fn has_own_placeholders_finds_own_identifier_only() {
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let lazy = [("bin/tool", exec_entry_tar("bin/tool", TOOL), 0o755)];
        let (exe, app_dir) = fixture(&root, work.path(), "pf-scan", &lazy);
        let members = &inspect_binary(&exe).unwrap().config.lazy;
        assert!(has_own_placeholders(&app_dir, members, "pf-scan"));
        assert!(!has_own_placeholders(&app_dir, members, "other-id"));
        // Materialize it, and the scan finds nothing.
        let p = placeholder_at(&app_dir.join("bin/tool")).unwrap().unwrap();
        materialize_into(std::slice::from_ref(&exe), &p, &app_dir.join("bin/tool")).unwrap();
        assert!(!has_own_placeholders(&app_dir, members, "pf-scan"));
    }

    #[test]
    fn prefetch_sweep_removes_only_dead_temps() {
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let lazy = [("bin/tool", exec_entry_tar("bin/tool", TOOL), 0o755)];
        let (_exe, app_dir) = fixture(&root, work.path(), "pf-sweep", &lazy);
        let dead = app_dir.join(format!("bin/.tool.caxa-{DEAD_PID}-999"));
        fs::write(&dead, b"partial").unwrap();
        let live = app_dir.join(format!("bin/.tool.caxa-{}-42", process::id()));
        fs::write(&live, b"in-flight").unwrap();
        // A writer whose pid looks dead from here (another PID namespace
        // sharing the cache) but still holds the flock on its temp file.
        let foreign = app_dir.join(format!("bin/.tool.caxa-{DEAD_PID}-7"));
        fs::write(&foreign, b"in-flight").unwrap();
        let held = File::open(&foreign).unwrap();
        assert!(lock_exclusive(&held, true));
        sweep_abandoned_temps(&app_dir, &inspect_binary(&_exe).unwrap().config.lazy);
        assert!(!dead.exists(), "a dead process's temp file must be swept");
        assert!(live.exists(), "a live process's temp file must be kept");
        assert!(foreign.exists(), "a temp file whose writer holds its lock must be kept");
        drop(held);
        sweep_abandoned_temps(&app_dir, &inspect_binary(&_exe).unwrap().config.lazy);
        assert!(!foreign.exists(), "released, it is abandoned");
    }

    #[test]
    fn prefetch_lock_pid_zero_or_negative_is_not_alive() {
        // kill(0, 0) and kill(-1, 0) succeed (they address process groups);
        // a lock holding such a value must not look like a live prefetcher.
        assert!(!process_alive(Some(0)));
        assert!(!process_alive(Some(-1)));
        assert!(process_alive(Some(process::id() as i32)));
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let path = prefetch_lock_path(&root, "lock-zero", "0");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"0").unwrap();
        let taken = take_prefetch_lock(&root, "lock-zero", "0").expect("a pid-0 lock must be replaced");
        drop(taken);
    }

    #[test]
    fn prefetch_lock_never_recreates_a_deleted_cache() {
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap().join("gone");
        assert!(take_prefetch_lock(&root, "lock-gone", "0").is_none());
        assert!(!root.exists(), "the deleted cache root must stay deleted");
    }

    #[test]
    fn prefetch_reuses_one_pair_of_buffers() {
        // Members of different sizes, largest in the middle: every member
        // decodes into the same buffers and lands with its own bytes.
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let big: Vec<u8> = (0..300_000u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8)
            .collect();
        let lazy = [
            ("bin/a", exec_entry_tar("bin/a", b"#!/bin/sh\necho a\n"), 0o755),
            ("bin/b", exec_entry_tar("bin/b", &big), 0o755),
            ("bin/c", exec_entry_tar("bin/c", b"#!/bin/sh\necho c\n"), 0o755),
        ];
        let (exe, app_dir) = fixture(&root, work.path(), "pf-buffers", &lazy);
        drop(try_prefetch_in(&exe, Some(os(&app_dir)), &root).unwrap());
        assert_eq!(fs::read(app_dir.join("bin/a")).unwrap(), b"#!/bin/sh\necho a\n");
        assert_eq!(fs::read(app_dir.join("bin/b")).unwrap(), big);
        assert_eq!(fs::read(app_dir.join("bin/c")).unwrap(), b"#!/bin/sh\necho c\n");
        assert!(app_dir.join(PREFETCH_MARKER).exists());
    }

    #[test]
    fn prefetch_mode_is_sticky_on_the_member_mode() {
        let cache = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(cache.path()).unwrap();
        let work = tempfile::tempdir().unwrap();
        let lazy = [("bin/tool", exec_entry_tar("bin/tool", TOOL), 0o750)];
        let (exe, app_dir) = fixture(&root, work.path(), "pf-mode", &lazy);
        let lock = try_prefetch_in(&exe, Some(os(&app_dir)), &root).unwrap();
        drop(lock);
        let mode = fs::metadata(app_dir.join("bin/tool")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o750);
    }
}
