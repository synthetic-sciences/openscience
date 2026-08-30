# OpenScience desktop

The desktop shell starts the bundled OpenScience runtime on a random loopback port and opens the existing workspace in a native window. It never exposes Node APIs to the workspace.

Release builds produce:

- macOS `.dmg` installers and `.zip` self-update payloads (Apple Silicon and Intel)
- Windows NSIS `.exe`
- Linux `.AppImage`

Set `OPENSCIENCE_DESKTOP_SIDECAR` to the native runtime before running `bun run dist`. Electron Builder automatically signs when `CSC_LINK` and `CSC_KEY_PASSWORD` are present. macOS notarization additionally uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Stable production releases require those credentials and sign, notarize, and staple both the app bundle and its outer DMG installer.

Only a notarized Developer ID build participates in desktop self-update. It downloads the exact architecture-specific ZIP from a published, non-prerelease GitHub release; verifies GitHub's SHA-256 digest, app identity, version, notarization, and publisher continuity; then uses the bundled signed sidecar for an atomic handoff. Stable publication keeps one packaged updater smoke on the release path; the full Apple Silicon and Intel lifecycle/rollback matrix remains available in deep CI. Ad-hoc-signed development builds remain useful for local packaging checks, but are never published as stable updater payloads and cannot self-update.
