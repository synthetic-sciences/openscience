# Architecture

This document explains how OpenScience is put together, so you can find your way around the codebase and know where a change belongs.

## The shape of the system

When you run `openscience`, the CLI starts a local server and opens a workspace in your browser. Everything runs on your machine.

```
  Browser workspace  (frontend/workspace, SolidJS)
        |  HTTP + SSE, localhost only
        v
  Local server       (backend/cli/src/server)
        |
        +--  Agent runtime      sessions, message loop, model routing
        +--  Tool layer         shell, edit, LSP, MCP, science connectors
        +--  Skills             bundled and user-installed skill packs
        +--  Providers          Anthropic, OpenAI, Google, and 75+ more
        |
        +--  Atlas client       optional: managed models, wallet, graph
```

The server binds to `127.0.0.1` and enforces a Host and Origin allowlist. There is no remote mode.

## Repository layout

```
backend/cli          The CLI, server, agent runtime, tools, and skills
frontend/workspace   The workspace UI (SolidJS), served by the CLI
frontend/ui          Shared UI components, themes, and fonts
frontend/docs        The documentation and session-share site (Astro)
frontend/landing     The marketing site (openscience.sh)
tooling/sdk/js       The TypeScript SDK, generated from the server contract
tooling/plugin       The plugin runtime (@synsci/plugin)
tooling/launcher     The `npx synsci` installer
tooling/repo         Release automation
tooling/script       Build helper used across packages
tooling/util         Shared TypeScript utilities (@synsci/util)
tooling/patches      Dependency patches applied at install time
```

## Backend (`backend/cli`)

The backend is a Bun and TypeScript application compiled to a single native binary per platform.

- `src/index.ts` registers the CLI commands and boots the process. Running `openscience` with no subcommand opens the workspace (`src/cli/cmd/web.ts`).
- `src/server` is a Hono server. It serves the embedded workspace UI, exposes the session and tool APIs, and streams events back to the browser over SSE.
- `src/session` is the agent runtime: the message loop, tool dispatch, compaction, provenance, durable runtime events, and explicit read-only review passes for sessions or immutable artifact versions.
- `src/agent` holds the agent registry and prompts. `research` is the single user-facing agent; it loads domain knowledge through skills and may delegate bounded Explore, Execute, or Review work internally. Domain and legacy helper profiles remain hidden compatibility aliases; `plan` is a read-only mode.
- `src/provider` routes each request to a model. Model definitions come from [models.dev](https://models.dev), cached locally with a bundled snapshot as a fallback.
- `src/tool` and `src/science` implement the tools the agent can call, including the shell, editor, LSP bridge, MCP client, and the scientific database connectors.
- `src/openscience` is the Atlas client. It is optional; the base install and every bring-your-own-key flow work without it.

### Prompt architecture

Prompts are assembled in two layers: a provider-level system prompt selected by model (`src/session/system.ts`), and an agent-level workflow prompt injected by agent name (`src/session/prompt.ts`). See [CLAUDE.md](CLAUDE.md) for the routing details.

### Skills

Skills are instruction bundles the agent loads on demand (`src/skill`). The canonical default library is `backend/cli/skills`; releases embed a compressed, hashed copy of the complete tree and materialize it into a versioned local cache. Learned skills, user-authored skills, Git-installed skills, and project skills are also local. Skill discovery, loading, security review, installation, and removal never require Atlas. An authenticated upgrade can perform a one-time read-only import of skill records created by older releases.

## Frontend

- `frontend/workspace` is the workspace UI. It talks to the local server over the same API the SDK exposes, and renders sessions, files, a terminal, and inline scientific views (molecules, structures, genomes, plots). The CLI build embeds the compiled UI into the binary.
- `frontend/ui` is the shared component and theme library used by the app and the docs site.
- `frontend/docs` is the Astro documentation and share site.

## SDK and plugins

- `tooling/sdk/js` is generated from the server's OpenAPI contract. Run `./tooling/repo/generate.ts` after changing the server API to regenerate it.
- `tooling/plugin` is the plugin runtime. Plugins receive a typed client and can add tools, providers, and hooks.

## Configuration and state

Global config lives in `~/.config/openscience/openscience.json`; project config in `openscience.json` or a `.openscience/` directory at the repo root. Persistent application data (sessions, auth, credentials, binaries, and logs) defaults to the stable `~/.openscience` data root and can be relocated; config, cache, and state use their resolved XDG directories. `src/global/index.ts` owns those paths. Installs made before the OpenScience rename import or migrate the legacy `synsc` directories on first run.

## Atlas integration

Atlas is a separate, closed platform. Only its optional client lives here. OpenScience starts and remains useful without an Atlas installation, login, or network connection. After login, the client enables managed models, wallet and credential synchronization, Codex credential backup, research graphs, library search, cloud evidence, and publishing. The standalone `@synsci/atlas` CLI is an optional companion and is used when present, but it is never required to run OpenScience. The wire contract uses the `synsci` model provider id, `thk_` wallet keys, and `/api/cli/*`, with `app.syntheticsciences.ai` as the default managed base URL (`src/endpoints.ts`). Skills are explicitly outside this contract.

## Build and release

`backend/cli/script/build.ts` fetches the model catalog, builds the workspace UI, and compiles the CLI to native binaries for Linux, macOS, and Windows. Each platform binary is published as its own npm package (`@synsci/openscience-<platform>`), and a small meta package (`@synsci/openscience`) selects the right one at install time. The `npx synsci` launcher installs that meta package. Releases run through `.github/workflows/publish.yml`.
