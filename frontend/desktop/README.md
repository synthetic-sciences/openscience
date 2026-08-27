# OpenScience desktop

The desktop shell starts the bundled OpenScience runtime on a random loopback port and opens the existing workspace in a native window. It never exposes Node APIs to the workspace.

Release builds produce:

- macOS `.dmg` (Apple Silicon and Intel)
- Windows NSIS `.exe`
- Linux `.AppImage`

Set `OPENSCIENCE_DESKTOP_SIDECAR` to the native runtime before running `bun run dist`. Electron Builder automatically signs when `CSC_LINK` and `CSC_KEY_PASSWORD` are present. macOS notarization additionally uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`.
