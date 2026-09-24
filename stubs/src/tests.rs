// Unit tests for the caxa runtime stub.

use super::*;
use std::collections::BTreeMap;
use std::io::Write;

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
