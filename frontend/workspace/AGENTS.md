## Debugging

- NEVER try to restart the app, or the server process, EVER.

## Local Dev

- For local UI changes, run the backend and app dev servers separately.
- Backend (repo root): `bun dev serve` (listens on 4096, falls back to 4097; set `VITE_OPENSCIENCE_SERVER_PORT` if it did).
- App (repo root): `bun run dev:ui`, then open `http://localhost:3000`.
- Unit tests: `bun run test:workspace` from the repo root (happy-dom). Playwright specs: `bun run --cwd frontend/workspace test`.

## SolidJS

- Always prefer `createStore` over multiple `createSignal` calls

## Tool Calling

- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.

## Browser Automation

Use `agent-browser` for web automation. Run `agent-browser --help` for all commands.

Core workflow:

1. `agent-browser open <url>` - Navigate to page
2. `agent-browser snapshot -i` - Get interactive elements with refs (@e1, @e2)
3. `agent-browser click @e1` / `fill @e2 "text"` - Interact using refs
4. Re-snapshot after page changes
