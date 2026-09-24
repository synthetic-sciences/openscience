# OpenScience desktop

The desktop shell starts the bundled OpenScience runtime on a random loopback port and opens the existing workspace in a native window. It never exposes Node APIs to the workspace.

Release builds produce:

- macOS `.dmg` installers, `.zip` self-update payloads, and `.zip.blockmap` download metadata (Apple Silicon and Intel)
- Windows NSIS `.exe`
- Linux `.AppImage`

## Run the shell from source

The shell runs unpackaged against a runtime built from the same checkout. From the repository root:

```bash
bun run setup --web
cd backend/cli && bun run build --single --skip-install   # the native runtime for this machine only
cd ../../frontend/desktop
OPENSCIENCE_DESKTOP_SIDECAR="$PWD/../../backend/cli/dist/@synsci/openscience-<platform>-<arch>/bin/openscience" \
  node_modules/.bin/electron .
```

`<platform>-<arch>` is the directory the build wrote, for example `darwin-arm64`, `linux-x64` or `windows-x64` (where the binary is `openscience.exe`). Without `OPENSCIENCE_DESKTOP_SIDECAR` an unpackaged shell looks for that same path for the current platform and architecture.

A packaged app accepts only a runtime that reports the app's own version, which is how a self-update proves it relaunched into the runtime it shipped with. A runtime built from source reports its build stamp (`0.0.0-main-<timestamp>`) instead, so an unpackaged shell, or one given `OPENSCIENCE_DESKTOP_SIDECAR`, checks only that the runtime is live and writes the version it reports to stderr. The sidecar's own output is echoed to the terminal and kept in `openscience-sidecar.log`, with the previous run beside it as `openscience-sidecar.prev.log`. A shell run from source writes them to `logs` inside its `userData` directory, and so does any launch given `--user-data-dir=<directory>`, so a development run never rotates the installed app's log. The installed app keeps Electron's logs directory (`~/Library/Logs/OpenScience` on macOS, `logs` inside `userData` on Windows and Linux).

## Packaging

Set `OPENSCIENCE_DESKTOP_SIDECAR` to the native runtime before running `bun run dist`. Local builds are unsigned on Windows and ad-hoc signed on macOS. Production packaging sets `OPENSCIENCE_DESKTOP_SIGNED=true`.

macOS signing uses `CSC_LINK` and `CSC_KEY_PASSWORD`; notarization additionally uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Stable production releases require those credentials and sign, notarize, and staple both the app bundle and its outer DMG installer.

Windows production packaging runs on Windows and uses Microsoft Artifact Signing with a validated Public Trust certificate profile. Set `WINDOWS_SIGNING_ENDPOINT`, `WINDOWS_SIGNING_ACCOUNT`, `WINDOWS_SIGNING_PROFILE`, and `WINDOWS_SIGNING_PUBLISHER` (the exact certificate common name). Authenticate with Azure CLI before packaging; GitHub Actions uses OIDC, without a client secret or exportable signing key. Electron Builder signs the copied sidecar, app executables, native libraries, NSIS uninstaller, and installer. The release workflow verifies Authenticode trust, publisher, and timestamps on the installer and bundled PE files before upload, and rechecks downloaded installers when resuming a release. While the Artifact Signing values are not configured in the repository, stable releases publish the Windows installer unsigned and the workflow says so in a warning. See [release setup](../../docs/notes/release-process.md#windows-signing-setup).

Only a notarized Developer ID build participates in desktop self-update. It downloads the exact architecture-specific ZIP from a published, non-prerelease GitHub release; verifies GitHub's SHA-256 digest, app identity, version, notarization, and publisher continuity; then uses the bundled signed sidecar for an atomic handoff. Stable publication requires both Apple Silicon and Intel download, activation, health, cleanup, and rollback checks. Ad-hoc-signed development builds remain useful for local packaging checks, but are never published as stable updater payloads and cannot self-update.

The macOS updater retains one verified ZIP and its block map under `updates/download-cache`. Later downloads reuse matching chunks and fetch changed byte ranges from GitHub, including when versions are skipped. A missing, damaged, or incompatible cache/map or an unsupported range response uses the full ZIP automatically. Cancellation never starts a fallback download. The reconstructed ZIP must match the complete published SHA-256 before the existing app signature, publisher, activation, and rollback checks run. Cache retention is best-effort and does not prevent installation. The first update carrying this downloader uses the full ZIP to establish its baseline.

`electron-updater` is pinned for its download-plan API only; installation continues through OpenScience's signed helper. `script/update-blockmap.mjs` uses the pinned Electron Builder generator. Production generates both architecture maps, binds them to release checksums, and runs `script/update-download-canary.mjs` against the previous signed release automatically.
