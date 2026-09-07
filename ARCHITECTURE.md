# Architecture

This document explains how OpenScience is put together, so you can find your way around the codebase and know where a change belongs.

The [scientific harness design](docs/notes/scientific-harness-design.md) explains
what should stay small, how extensions fit, and how to evaluate quality and cost
across the five target science benchmarks without changing their native contracts.

## The shape of the system

When you run `openscience`, the CLI starts a local server and opens a workspace in your browser. The workspace, durable state, permissions, and compute control plane run on your machine. Model calls, scientific connectors, and explicitly approved remote-compute jobs may use the provider you configure.

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
        +--  Compute jobs       local, SSH, scheduler, and user-owned Modal runs
```

The server binds to `127.0.0.1` and enforces a Host and Origin allowlist. A configured deployment bearer token protects the whole local service; project selectors do not create tenant isolation. Remote applications need a separately authenticated gateway and an appropriate execution boundary.

`openscience serve` owns the same Research loop without opening the workbench. A `--headless` source build omits the embedded UI; the normal combined build remains available. Frontends and integrations submit work through the public runtime contract, while the native CLI/Harbor adapter retains its versioned JSONL process contract over the same session/tool loop.

```text
Workbench / TypeScript client / Python client
                            | HTTP commands + SSE observations
                     Public runtime protocol
                            | admission / decisions / cancellation
                     Research session + tool loop
                            | existing scoped services
                 Files / Results / compute jobs / plugins / MCP
```

`src/runtime/runs.ts` records request receipts before model execution and serializes admission across processes. An identical request ID returns the same run; changed content conflicts. Terminal receipts outlive the bounded event journal. Loss of the owning process interrupts unfinished work rather than automatically repeating external effects. `src/runtime/decisions.ts` records responses to live permission/question continuations; it does not recreate an approval continuation after a server crash. Ambiguous decisions are reported as indeterminate.

The workbench negotiates capabilities before using the runtime. A confirmed missing capability endpoint allows an older server's legacy prompt path; an uncertain submission never falls back to another submission route. Domain logic remains below HTTP routes. See the [runtime contract](frontend/docs/src/content/openscience/api.mdx) and [headless hosting](frontend/docs/src/content/openscience/server-hosting.mdx) for lifecycle and compatibility details.

## Repository layout

```
backend/cli          The CLI, server, agent runtime, tools, connectors, and skills
frontend/workspace   The workspace UI (SolidJS), served by the CLI
frontend/desktop     The Electron shell that wraps the packaged runtime
frontend/ui          Shared UI components, themes, and icons
frontend/docs        The documentation site (Vite + React)
frontend/landing     The marketing site (openscience.sh); has its own lockfile
tooling/sdk/js       The TypeScript SDK, generated from the server contract
tooling/sdk/python   The dependency-free Python HTTP/SSE client
tooling/harbor       The installed-agent adapter for native Harbor tasks
tooling/plugin       The plugin runtime (@synsci/plugin)
tooling/launcher     The `npx synsci` installer
tooling/repo         Repo automation: contributor setup, SDK regeneration, release scripts
tooling/script       Build helper used across packages
tooling/util         Shared TypeScript utilities (@synsci/util)
tooling/patches      Dependency patches applied at install time
evals                Launch evals and the cadence dev lab for the research harness
docs                 Engineering notes (docs/notes), ADRs, specs, and historical plans
.openscience         Repo-local agent config (commands, a skill, a theme) used by `bun dev "$PWD"`
```

## Backend (`backend/cli`)

The backend is a Bun and TypeScript application compiled to a single native binary per platform.

- `src/index.ts` registers the CLI commands and boots the process. Running `openscience` with no subcommand opens the workspace (`src/cli/cmd/web.ts`).
- `src/server` is a Hono server. It serves the embedded workspace UI, exposes the session and tool APIs, and streams events back to the browser over SSE.
- `src/session` is the agent runtime: the message loop, tool dispatch, compaction, provenance, durable runtime events, and explicit read-only review passes for sessions or immutable artifact versions.
- `src/agent` holds the agent registry and prompts. `research` is the single user-facing agent; it loads domain knowledge through skills and may delegate independent Explore or Execute work internally. Delegation posture changes how readily it parallelizes, while runtime capacity provides the actual concurrency boundary. Domain and legacy helper profiles remain hidden compatibility aliases; `plan` is a read-only mode.
- `src/provider` routes each request to a model. Model definitions come from [models.dev](https://models.dev), cached locally with a bundled snapshot as a fallback. Native direct-key routes stay distinct from relays: DeepSeek direct BYOK uses the official adapter, while selecting an explicit OpenRouter model keeps that request on OpenRouter.
- `src/tool` and `src/science` implement the tools the agent can call, including the shell, editor, LSP bridge, MCP client, and the scientific database connectors. The versioned scientific capability registry contains a truthful 54-entry inventory. Five experimental Python capabilities own a complete doctor/setup/plan/start/status/wait/logs/artifacts/verify/cancel/retry/release lifecycle over exact local or Modal runtime locks; ten experimental BioNeMo capabilities use strict in-process BYOK NVIDIA NIM adapters. Two entries are explicitly blocked and none is called verified without matching release evidence. The single `scientific_capability` tool owns those lifecycles so a model never needs a second, separately selected compute tool to finish an approved run.
- `src/compute` owns durable local and remote job lifecycles. Modal dispatch is bound to an approved digest, explicit files and secrets, durable ownership, and recoverable output delivery. Its concurrency setting is an admission limit: starts beyond the limit fail visibly rather than entering an autonomous waiting queue.
- `src/openscience` contains local credential redaction and subprocess-environment boundaries.

### Prompt architecture

An explicit agent header replaces the generic fallback. Default Research uses the
short `researchagent-test.txt` header plus response defaults; session assembly adds
environment, project instructions and applicable mode/skill context. Provider
transforms then adapt request options, tools, reasoning and message serialization.
The generic fallback currently ignores model identity, and Research bypasses it.
Codex OAuth places the Research header once in the API instructions field. See
[CLAUDE.md](CLAUDE.md) for the actual routing and
[the OpenCode comparison](docs/notes/opencode-harness-comparison.md) for the upstream
prompt-selection and provider-transport analysis.

### Skills

Skills are instruction bundles the agent loads on demand (`src/skill`). The canonical default library is `backend/cli/skills`; releases embed a compressed, hashed copy of the complete tree and materialize it into a versioned local cache. User-authored skills, Git-installed skills, and project skills are also local. Skill discovery, loading, security review, installation, and removal never require the Gateway. An authenticated upgrade can perform a one-time read-only import of skill records created by older releases.

## Frontend

- `frontend/workspace` is the workspace UI. It talks to the local server over the same API the SDK exposes, and renders sessions, files, a terminal, and inline scientific views (molecules, structures, genomes, plots). The CLI build embeds the compiled UI into the binary.
- `frontend/ui` is the shared component and theme library used by the app and the docs site.
- `frontend/desktop` is the Electron shell. It starts the packaged native runtime on a random loopback port and opens the same workspace in a native window; it never exposes Node APIs to the page.
- `frontend/docs` is the Vite + React documentation site.

## SDK and plugins

- `tooling/sdk/js` is generated from the server's OpenAPI contract. Run `./tooling/repo/generate.ts` after changing the server API to regenerate it.
- `tooling/sdk/js/src/v2/runtime.ts` is the stable result-oriented facade over the generated client. Its stream reconnection carries a cursor; a gap requires snapshot recovery, never another prompt.
- `tooling/sdk/python` provides a standard-library HTTP/SSE client for Python integrations. It uses the same public protocol and is tested against the source server and a local fixture provider.
- `tooling/plugin` is the plugin runtime. Plugins receive a project-scoped client and can add tools, providers, connectors, and hooks. String results remain valid; structured results preserve metadata and attachments while the host assigns attachment identity. Trusted plugin code runs in the host process. MCP remains the process-separated tool protocol.
- `tooling/harbor` keeps native tasks, images, graders, limits, and aggregation in Harbor. Only the installed-agent boundary and root trajectory conversion belong here; compatibility is explicitly pinned to Harbor 0.22.0.

## Generated files and the dev loop

Three files the backend imports are gitignored and produced by scripts: `backend/cli/src/web/assets.generated.ts` (the embedded workspace UI, from a `frontend/workspace` build plus `backend/cli/script/generate-web-assets.ts`), `backend/cli/src/provider/models-snapshot.ts` (the models.dev catalog snapshot), and `backend/cli/src/skill/bundled.generated.ts` (the compressed skill archive, release builds only). `bun run setup` (`tooling/repo/setup.ts`) creates the first two so `bun dev` serves the workspace on a fresh clone; `bun dev serve` plus `bun run dev:ui` is the hot-reload loop for UI work. Tests never need them. [CONTRIBUTING.md](CONTRIBUTING.md) has the details.

## Configuration and state

Global config lives in `~/.config/openscience/openscience.json`; project config in `openscience.json` or a `.openscience/` directory at the repo root. Persistent application data (sessions, auth, credentials, binaries, and logs) defaults to the stable `~/.openscience` data root and can be relocated; config, cache, and state use their resolved XDG directories. `src/global/index.ts` owns those paths. Installs made before the OpenScience rename import or migrate the legacy `synsc` directories on first run.

## Build and release

`backend/cli/script/build.ts` fetches the model catalog, builds the workspace UI, and compiles the CLI to native binaries for Linux, macOS, and Windows. Each platform binary is published as its own npm package (`@synsci/openscience-<platform>`), and a small meta package (`@synsci/openscience`) selects the right one at install time. The `npx synsci` launcher installs that meta package. Releases run through `.github/workflows/publish.yml`. Stable macOS releases require Developer ID signing and notarization; ad-hoc-signed development packages are local-only and never enter the stable update channel. Windows signing remains optional and an unsigned Windows installer is disclosed in release notes.
