# OpenScience for VS Code

A Visual Studio Code extension that launches the [OpenScience](https://syntheticsciences.ai) workspace and lets you send file references to it from the editor.

## Prerequisites

This extension needs the OpenScience CLI (the `openscience` binary) installed. See [syntheticsciences.ai](https://syntheticsciences.ai) for install instructions.

## Features

- Launch: use `Cmd+Esc` (macOS) or `Ctrl+Esc` (Windows and Linux) to start OpenScience from VS Code.
- Context: share the current selection or open file with OpenScience.
- File references: use `Cmd+Option+K` (macOS) or `Alt+Ctrl+K` (Windows and Linux) to insert a file reference such as `@File#L37-42`.

## Support

This is an early release. If you hit a problem or have feedback, open an issue at https://github.com/synthetic-sciences/OpenScience/issues.

## Development

1. Open the `integrations/vscode` directory in VS Code (not the repo root): `code integrations/vscode`.
2. Run `bun install` inside that directory.
3. Press `F5` to launch a new VS Code window with the extension loaded.

`tsc` and `esbuild` watchers rebuild the extension in the background while you debug. To pick up changes, open the command palette in the debug window (`Cmd+Shift+P`), run `Developer: Reload Window`.
