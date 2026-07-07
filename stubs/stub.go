package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/klauspost/compress/gzip"
	"github.com/klauspost/compress/zstd"
)

type Config struct {
	Identifier           string   `json:"identifier"`
	Command              []string `json:"command"`
	UncompressionMessage string   `json:"uncompressionMessage"`
	Compression          string   `json:"compression"`
}

type fileJob struct {
	dest string
	data []byte
	mode int64
}

type binaryLayout struct {
	config        *Config
	payloadOffset int64
	payloadSize   int64
	payload       []byte
}

const maxBufferSize = 1 * 1024 * 1024
const archiveSeparator = "\nCAXACAXACAXA\n"
const trailerMagic = "CAXAIDX1"
const trailerSize = 32

func main() {
	exePath, err := os.Executable()
	if err != nil {
		log.Fatalf("caxa: failed to find executable: %v", err)
	}

	layout, err := inspectBinary(exePath)
	if err != nil {
		log.Fatalf("caxa: binary corrupted: %v", err)
	}

	appDir, err := prepareApplication(exePath, layout)
	if err != nil {
		log.Fatalf("caxa: failed to prepare application: %v", err)
	}

	if err := run(layout.config, appDir); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			os.Exit(exitErr.ExitCode())
		}
		log.Fatalf("caxa: execution failed: %v", err)
	}
}

func parseBinary(data []byte) (*Config, []byte, error) {
	footerSep := []byte("\n")
	footerIdx := bytes.LastIndex(data, footerSep)
	if footerIdx == -1 {
		return nil, nil, errors.New("footer not found")
	}

	var config Config
	if err := json.Unmarshal(data[footerIdx+1:], &config); err != nil {
		return nil, nil, fmt.Errorf("invalid footer json: %w", err)
	}

	archiveSep := []byte(archiveSeparator)
	archiveIdx := bytes.Index(data, archiveSep)
	if archiveIdx == -1 {
		return nil, nil, errors.New("archive separator not found")
	}

	payload := data[archiveIdx+len(archiveSep) : footerIdx]
	return &config, payload, nil
}

func inspectBinary(exePath string) (*binaryLayout, error) {
	file, err := os.Open(exePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}

	if info.Size() >= trailerSize {
		trailer := make([]byte, trailerSize)
		if _, err := file.ReadAt(trailer, info.Size()-trailerSize); err == nil {
			if string(trailer[:8]) == trailerMagic {
				payloadOffset := int64(binary.LittleEndian.Uint64(trailer[8:16]))
				payloadSize := int64(binary.LittleEndian.Uint64(trailer[16:24]))
				footerSize := int64(binary.LittleEndian.Uint64(trailer[24:32]))
				footerOffset := info.Size() - trailerSize - footerSize

				if payloadOffset < 0 || payloadSize < 0 || footerSize < 0 || footerOffset < 0 {
					return nil, errors.New("invalid trailer offsets")
				}
				if payloadOffset+payloadSize > footerOffset {
					return nil, errors.New("payload overlaps footer")
				}

				footer := make([]byte, footerSize)
				if _, err := file.ReadAt(footer, footerOffset); err != nil {
					return nil, fmt.Errorf("failed to read footer: %w", err)
				}

				var config Config
				if err := json.Unmarshal(footer, &config); err != nil {
					return nil, fmt.Errorf("invalid footer json: %w", err)
				}

				return &binaryLayout{
					config:        &config,
					payloadOffset: payloadOffset,
					payloadSize:   payloadSize,
				}, nil
			}
		}
	}

	data, err := os.ReadFile(exePath)
	if err != nil {
		return nil, err
	}

	config, payload, err := parseBinary(data)
	if err != nil {
		return nil, err
	}

	archiveIdx := bytes.Index(data, []byte(archiveSeparator))
	if archiveIdx == -1 {
		return nil, errors.New("archive separator not found")
	}

	return &binaryLayout{
		config:        config,
		payloadOffset: int64(archiveIdx + len(archiveSeparator)),
		payloadSize:   int64(len(payload)),
		payload:       payload,
	}, nil
}

func prepareApplication(exePath string, layout *binaryLayout) (string, error) {
	tempDir := os.Getenv("CAXA_TEMP_DIR")
	if tempDir == "" {
		tempDir = path.Join(os.TempDir(), "caxa")
	}

	for attempt := 0; ; attempt++ {
		id := layout.config.Identifier
		sAttempt := strconv.Itoa(attempt)

		appDir := path.Join(tempDir, "apps", id, sAttempt)
		lockDir := path.Join(tempDir, "locks", id, sAttempt)

		if info, err := os.Stat(appDir); err == nil && info.IsDir() {
			if _, err := os.Stat(lockDir); os.IsNotExist(err) {
				return appDir, nil
			}
			continue
		}

		if err := os.MkdirAll(lockDir, 0755); err != nil {
			return "", fmt.Errorf("failed to create lock: %w", err)
		}

		ctx, cancel := context.WithCancel(context.Background())
		if layout.config.UncompressionMessage != "" {
			fmt.Fprint(os.Stderr, layout.config.UncompressionMessage)
			go func() {
				t := time.NewTicker(2 * time.Second)
				defer t.Stop()
				for {
					select {
					case <-t.C:
						fmt.Fprint(os.Stderr, ".")
					case <-ctx.Done():
						fmt.Fprintln(os.Stderr, "")
						return
					}
				}
			}()
		}

		if err := extract(layout, exePath, appDir); err != nil {
			cancel()
			os.RemoveAll(appDir)
			os.RemoveAll(lockDir)
			return "", err
		}

		os.RemoveAll(lockDir)
		cancel()
		return appDir, nil
	}
}

func extract(layout *binaryLayout, exePath string, dest string) error {
	var (
		payloadReader io.Reader
		payloadFile   *os.File
		err           error
	)

	if len(layout.payload) > 0 {
		payloadReader = bytes.NewReader(layout.payload)
	} else {
		payloadFile, err = os.Open(exePath)
		if err != nil {
			return err
		}
		defer payloadFile.Close()
		payloadReader = io.NewSectionReader(payloadFile, layout.payloadOffset, layout.payloadSize)
	}

	var decompressedPayload io.ReadCloser
	switch layout.config.Compression {
	case "", "gzip":
		gr, err := gzip.NewReader(payloadReader)
		if err != nil {
			return err
		}
		decompressedPayload = gr
	case "zstd":
		zr, err := zstd.NewReader(payloadReader)
		if err != nil {
			return err
		}
		decompressedPayload = zr.IOReadCloser()
	default:
		return fmt.Errorf("unsupported payload compression: %s", layout.config.Compression)
	}
	defer decompressedPayload.Close()

	tr := tar.NewReader(decompressedPayload)

	// node_modules trees contain thousands of files sharing a handful of parent
	// directories. Caching created directories avoids a redundant MkdirAll
	// syscall per file. MkdirAll is idempotent, so the rare duplicate under a
	// race is harmless.
	var createdDirs sync.Map
	ensureDir := func(dir string) error {
		if _, seen := createdDirs.Load(dir); seen {
			return nil
		}
		if err := os.MkdirAll(dir, 0755); err != nil {
			return err
		}
		createdDirs.Store(dir, struct{}{})
		return nil
	}

	numWorkers := runtime.NumCPU()
	jobs := make(chan fileJob, numWorkers*2)
	errChan := make(chan error, numWorkers)
	var wg sync.WaitGroup

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for job := range jobs {
				if err := ensureDir(filepath.Dir(job.dest)); err != nil {
					select {
					case errChan <- err:
					default:
					}
					return
				}
				if err := os.WriteFile(job.dest, job.data, os.FileMode(job.mode)); err != nil {
					select {
					case errChan <- err:
					default:
					}
					return
				}
			}
		}()
	}

	for {
		select {
		case err := <-errChan:
			close(jobs)
			return err
		default:
		}

		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			close(jobs)
			return err
		}

		target := filepath.Join(dest, filepath.FromSlash(header.Name))

		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			close(jobs)
			return fmt.Errorf("illegal file path: %s", header.Name)
		}

		switch header.Typeflag {
		case tar.TypeDir:
			if err := ensureDir(target); err != nil {
				close(jobs)
				return err
			}
		case tar.TypeReg:
			if header.Size < maxBufferSize {
				buf := make([]byte, header.Size)
				if _, err := io.ReadFull(tr, buf); err != nil {
					close(jobs)
					return err
				}
				jobs <- fileJob{dest: target, data: buf, mode: header.Mode}
			} else {
				if err := ensureDir(filepath.Dir(target)); err != nil {
					close(jobs)
					return err
				}
				f, err := os.OpenFile(target, os.O_CREATE|os.O_RDWR, os.FileMode(header.Mode))
				if err != nil {
					close(jobs)
					return err
				}
				if _, err := io.Copy(f, tr); err != nil {
					f.Close()
					close(jobs)
					return err
				}
				f.Close()
			}
		case tar.TypeSymlink:
			if err := ensureDir(filepath.Dir(target)); err != nil {
				close(jobs)
				return err
			}
			_ = os.Remove(target)
			if err := os.Symlink(header.Linkname, target); err != nil {
				close(jobs)
				return err
			}
		}
	}

	close(jobs)
	wg.Wait()

	select {
	case err := <-errChan:
		return err
	default:
		return nil
	}
}

func run(config *Config, appDir string) error {
	args := make([]string, len(config.Command))
	rx := regexp.MustCompile(`\{\{\s*caxa\s*\}\}`)

	for i, part := range config.Command {
		args[i] = rx.ReplaceAllLiteralString(part, appDir)
	}

	if len(os.Args) > 1 {
		args = append(args, os.Args[1:]...)
	}

	if len(args) == 0 {
		return errors.New("no command defined")
	}

	env := childEnv(appDir)

	// When the target is caxa's portable Node shell wrapper, bypass it: set the
	// dynamic-library search path ourselves and run the real executable directly.
	// This removes an intermediate shell process from every launch.
	if realExe, libsDir, ok := resolvePortableNode(args[0]); ok {
		args[0] = realExe
		env = withLibraryPath(env, libsDir)
	}

	// On Unix, replace the stub process with the target via execve: no lingering
	// stub in the process tree, signals are delivered straight to the child, and
	// the child's own exit status becomes ours. syscall.Exec only returns on
	// failure to exec.
	if runtime.GOOS != "windows" {
		if err := syscall.Exec(args[0], args, env); err != nil {
			return fmt.Errorf("failed to exec %s: %w", args[0], err)
		}
		return nil
	}

	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = env
	return cmd.Run()
}

// resolvePortableNode detects caxa's portable Node layout produced by the
// packager: a shell wrapper `<name>` sitting next to the real binary
// `<name>-real` and a `<name>-libs` directory of bundled shared libraries. When
// present, the wrapper only exists to export the library search path, so the
// stub can skip it and launch the real binary directly. Windows has no wrapper.
func resolvePortableNode(exe string) (realExe string, libsDir string, ok bool) {
	if runtime.GOOS == "windows" {
		return "", "", false
	}
	realExe = exe + "-real"
	libsDir = exe + "-libs"
	if fi, err := os.Stat(realExe); err != nil || fi.IsDir() {
		return "", "", false
	}
	if fi, err := os.Stat(libsDir); err != nil || !fi.IsDir() {
		return "", "", false
	}
	return realExe, libsDir, true
}

// withLibraryPath prepends libsDir to the platform's dynamic-library search
// path, mirroring the behaviour of the portable Node shell wrapper.
func withLibraryPath(env []string, libsDir string) []string {
	key := "LD_LIBRARY_PATH"
	if runtime.GOOS == "darwin" {
		key = "DYLD_LIBRARY_PATH"
	}
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	found := false
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			existing := kv[len(prefix):]
			if existing != "" {
				out = append(out, prefix+libsDir+string(os.PathListSeparator)+existing)
			} else {
				out = append(out, prefix+libsDir)
			}
			found = true
		} else {
			out = append(out, kv)
		}
	}
	if !found {
		out = append(out, prefix+libsDir)
	}
	return out
}

// childEnv points Node's on-disk compile cache (Node >= 22) at the reused
// application directory so V8 bytecode is persisted after the first run,
// speeding up subsequent launches. It is harmless for non-Node runtimes and
// respects an existing NODE_COMPILE_CACHE / an opt-out via
// CAXA_DISABLE_COMPILE_CACHE.
func childEnv(appDir string) []string {
	env := os.Environ()
	if os.Getenv("CAXA_DISABLE_COMPILE_CACHE") != "" {
		return env
	}
	if _, set := os.LookupEnv("NODE_COMPILE_CACHE"); set {
		return env
	}
	return append(env, "NODE_COMPILE_CACHE="+path.Join(appDir, ".node-compile-cache"))
}
