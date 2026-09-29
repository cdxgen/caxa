# Security Policy

## Reporting Security Issues

The OWASP cdxgen team and community take security bugs seriously. We appreciate your efforts to responsibly disclose your findings, and will make every effort to acknowledge your contributions.

To report a security issue, email [security@cyclonedx.org](mailto:security@cyclonedx.org) and include the word **"SECURITY"** in the subject line.

The OWASP cdxgen team will send a response indicating the next steps in handling your report. After the initial reply to your report, the security team will keep you informed of the progress towards a fix and full announcement, and may ask for additional information or guidance.

Report security bugs in third-party modules to the person or team maintaining the module.

## Service Level Agreements (SLAs)

We use the following target response and resolution times for reported security issues. These SLAs are best-effort commitments, not contractual guarantees.

| Severity                                                                       | Initial Response | Triage / Confirmation | Remediation Target | Disclosure                |
| ------------------------------------------------------------------------------ | ---------------- | --------------------- | ------------------ | ------------------------- |
| **Critical** (arbitrary code execution, release compromise, cache poisoning)   | 48 hours         | 5 business days       | 15 business days   | Coordinated with reporter |
| **High** (path traversal, unsafe extraction, command injection)                | 5 business days  | 10 business days      | 30 business days   | Coordinated with reporter |
| **Medium** (information disclosure, denial of service, cache isolation bypass) | 10 business days | 15 business days      | 60 business days   | Next scheduled release    |
| **Low** (minor hardening issues, noisy error exposure)                         | 15 business days | 30 business days      | Best effort        | Next scheduled release    |

After remediation is available, we will publish a GitHub Security Advisory (GHSA) with CVE assignment where appropriate.

## What Counts as a Genuine Security Issue

### In scope

The following are considered genuine security issues in caxa:

- **Arbitrary code execution in caxa itself** — A crafted project tree, environment variable, archive entry, or runtime parameter causes the TypeScript builder or Rust runtime stub to execute attacker-controlled code outside the intended packaged application process.
- **Unsafe extraction / path traversal** — A packaged payload can write files outside the intended extraction directory, overwrite unrelated host files, or bypass extraction path checks.
- **Portable runtime bundling bypasses** — A packaged Node runtime or its supporting shared libraries are resolved from attacker-controlled locations instead of the intended bundled files.
- **Command injection during build** — User-controlled values escape the intended `upx`, `cargo`, or other subprocess command boundaries used by caxa.
- **Supply-chain integrity issues** — Compromise of published npm packages, release artifacts, GitHub Actions workflows, or the prebuilt Rust stub binaries.
- **Extraction cache isolation failures** — A vulnerability that lets one packaged application incorrectly reuse or poison another application's extracted cache contents.
- **Unexpected inclusion of sensitive files by default** — A default packaging behavior that unintentionally includes secrets, credentials, or host-specific sensitive material from the input tree.
- **Denial of service through malicious payload metadata** — Crafted payloads, footers, or compression streams that cause unbounded memory, CPU, or disk consumption in caxa itself beyond expected packaging or extraction work.

### Out of scope

The following are generally **not** considered security issues in caxa:

- **Vulnerabilities in the packaged application** — caxa packages existing Node.js applications. Bugs in the packaged app or its dependencies are the responsibility of that application's maintainers.
- **Intentional visibility of packaged source code** — caxa is a packaging tool, not a code-obfuscation or DRM product. Extracted application files being readable on disk is expected behavior.
- **Third-party runtime vulnerabilities** — Vulnerabilities in Node.js, UPX, Rust/zig toolchains, package managers, or operating system libraries should be reported to those upstream projects unless caxa introduces a distinct exploit path.
- **Large application size or extraction time by itself** — caxa intentionally packages application trees. General resource consumption from large inputs is expected unless it exposes a specific algorithmic complexity or bounds-check failure.
- **Manual misconfiguration** — Using `--include-node` or custom stubs in unsupported ways, or explicitly choosing insecure custom build inputs, is not by itself a caxa vulnerability.
- **Automated scanner findings without impact** — Reports consisting only of dependency CVEs or static scanner output without a demonstrated exploit path in caxa.

### Grey areas

These require case-by-case evaluation:

- **Default exclude behavior** — Excluding too little can bloat binaries or leak metadata; excluding too much can break runtime behavior. Reports should show a concrete security or integrity impact, not just a packaging preference.
- **Shared cache behavior** — caxa intentionally reuses extraction caches for identical payloads. Reports must show cross-application interference or integrity compromise, not simply cache reuse.
- **Portable Node library discovery** — Reports involving unusual platform-specific dynamic library layouts are in scope if they show caxa loading attacker-controlled code or omitting required security boundaries.

## Shared Responsibility Model

caxa operates at the intersection of application packaging, archive creation, native bootstrap execution, and runtime extraction. Security responsibility is shared among caxa, its users, the packaged application, and upstream runtimes/tools.

### What caxa is responsible for

| Area                                | Responsibility                                                              | Key Controls                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Own code safety**                 | Preventing injection, traversal, and unintended code execution in caxa      | Array-based subprocess invocation, payload/footer validation, archive path normalization                |
| **Runtime extraction safety**       | Ensuring packaged payloads only extract inside the intended cache directory | Tar path validation, symlink handling, lock directories, bounded extraction flow                        |
| **Portable runtime correctness**    | Bundling the intended Node runtime and required shared libraries safely     | Runtime dependency discovery, wrapper scripts, explicit packaged library lookup paths                   |
| **Cache integrity**                 | Preventing accidental cache collisions between different payload contents   | Content-addressed identifiers for identical payloads, build identifiers when explicitly requested       |
| **Supply-chain integrity**          | Protecting release artifacts and published packages from tampering          | Source-controlled Rust stubs, npm package publication, GitHub workflow review, release artifact hygiene |
| **Conservative packaging defaults** | Avoiding obviously non-runtime or secret-bearing file classes by default    | Default excludes for docs, tests, sourcemaps, declarations, and packaging metadata                      |
| **Timely patching**                 | Keeping caxa's own dependencies and release process maintained              | Minimal runtime dependency set, test suite coverage, cross-platform stub rebuilds                       |

### What users are responsible for

| Area                          | Responsibility                                                       | Guidance                                                                              |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **Input trust**               | Understanding the trust level of the application tree being packaged | Do not package untrusted projects on sensitive machines without isolation             |
| **Packaged application code** | Securing the app that caxa bundles                                   | Audit runtime behavior, dependency scripts, and secrets independently of caxa         |
| **Custom excludes/includes**  | Choosing whether defaults should be tightened or loosened            | Review what your app actually needs at runtime before overriding caxa defaults        |
| **Runtime environment**       | Securing the host or container where packaged binaries execute       | Use dedicated temp/cache locations when required and apply host-level access controls |
| **UPX / custom toolchain**    | Securing external tools invoked during packaging                     | Keep UPX, Rust, zig, Node.js, and CI images updated                                   |
| **Release verification**      | Verifying distributed binaries and update channels                   | Sign artifacts, publish checksums, and validate binaries in CI/CD                     |

### What upstream projects are responsible for

| Area                                                                      | Responsible Party                   |
| ------------------------------------------------------------------------- | ----------------------------------- |
| Vulnerabilities in Node.js, Rust crates, UPX, or platform dynamic loaders | Respective runtime/tool maintainers |
| Vulnerabilities in packaged applications and their npm dependencies       | Application maintainers             |
| Vulnerabilities in the runtime dependencies (`archiver`, `@cdxgen/cdx-purl`) | Dependency maintainers            |
| CI runner / GitHub platform vulnerabilities                               | CI platform maintainers             |

## Security Features Reference

caxa includes several security-relevant controls and defaults:

- Native Rust bootstrap stub with footer and trailer validation
- Bounded, validated v2 frame index: frame count, frame and total sizes, and exact decoded sizes are checked before anything is extracted
- Lazy members verified by identifier, frame index entry and sha256 before they replace their placeholder
- Zip-slip protection during extraction
- Lock-based extraction to reduce cache corruption
- Portable Node bundling with explicit shared-library handling
- Content-addressed cache reuse for identical payloads
- Conservative default excludes for non-runtime `node_modules` content

For a deeper analysis of threats and controls, see [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Supported Versions

Security fixes are applied to the latest major line and, when practical, to the immediately previous maintained release line.

| Version                  | Supported   |
| ------------------------ | ----------- |
| Current major release    | ✅          |
| Previous maintained line | Best effort |
| Older releases           | ❌          |
