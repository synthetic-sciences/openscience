# OpenScience desktop

The desktop shell starts the bundled OpenScience runtime on a random loopback port and opens the existing workspace in a native window. It never exposes Node APIs to the workspace.

Release builds produce:

- macOS `.dmg` installers and `.zip` self-update payloads (Apple Silicon and Intel)
- Windows NSIS `.exe`
- Linux `.AppImage`

Set `OPENSCIENCE_DESKTOP_SIDECAR` to the native runtime before running `bun run dist`. Electron Builder automatically signs when `CSC_LINK` and `CSC_KEY_PASSWORD` are present. macOS notarization additionally uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Signed production releases sign, notarize, and staple both the app bundle and its outer DMG installer.

The first launch of an unsigned macOS build still requires Apple's explicit **Open Anyway** flow. After that one-time approval, the desktop app can download the exact architecture-specific ZIP from a published GitHub release, verify GitHub's SHA-256 asset digest and the app bundle identity/version/signature, replace itself, and restart. A Developer ID certificate plus notarization credentials remain the only way to remove the first-launch Gatekeeper warning.
