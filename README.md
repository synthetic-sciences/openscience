<div align="center">

<img src="assets/wordmark.svg" alt="OpenScience" width="440">

### The open-source AI workbench for scientific research

Give it a goal. It reads the literature, writes and runs code, runs the experiments, and writes up what it found.

<br/>

[![CI](https://github.com/synthetic-sciences/OpenScience/actions/workflows/ci.yml/badge.svg)](https://github.com/synthetic-sciences/OpenScience/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40synsci%2Fopenscience?label=%40synsci%2Fopenscience&color=0d9488)](https://www.npmjs.com/package/@synsci/openscience)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

[Install](#install) · [Quickstart](#quickstart) · [Configuration](#configuration)

</div>

---

OpenScience is an AI workbench for scientific research. You give it a goal, and it works through the research loop the way a capable collaborator would. It reads the papers that matter, forms a hypothesis, writes and runs code, runs experiments on your compute, queries the major scientific databases, and writes up the result. It runs as a workspace in your browser and works with frontier or open-weight models using your own keys, eligible provider subscriptions, or local models.

It is model-agnostic, open source, and built to do real work in machine learning, biology, physics, and chemistry.

## What it does

- **Runs the whole loop.** Literature review, hypothesis, code, experiment, analysis, and write-up, in one continuous session.
- **One adaptive Research agent.** A single user-facing collaborator handles the task end to end, loads domain skills when useful, and delegates independent Explore or Execute work when it helps. Off, Auto, and High delegation guide how readily it parallelizes without imposing a per-turn worker quota; plan mode stays read-only.
- **312 bundled skills.** Training (DeepSpeed, PEFT, TRL), evaluation, dataset work, molecular and clinical biology, cheminformatics, papers and LaTeX, figures, and user-configured scientific runtimes.
- **Scientific databases as tools.** 42 built-in connectors, including UniProt, PDB, Ensembl, ChEMBL, PubChem, arXiv, OpenAlex, and Semantic Scholar, queryable directly by the agent.
- **Governed scientific capabilities.** A truthful 54-entry inventory sits behind one lifecycle tool. Five experimental Python capabilities run through exact, hashed local or Modal environments; ten experimental BioNeMo capabilities use strict bring-your-own-key NVIDIA NIM adapters. No capability is labeled verified until a release-artifact canary passes.
- **A real workspace.** A browser UI with a file tree, an editor, a terminal, session history, and inline rendering for molecules, structures, genomes, and plots.
- **Extensible.** LSP integration, MCP servers, plugins, custom agents and commands, and a TypeScript SDK. Five reviewed connector presets help configure common MCP endpoints, but they save disabled for inspection and do not claim ELN, LIMS, clinical, or regulatory write-back.

## Install

Install with npm, then open the workspace:

```bash
npm install -g @synsci/openscience
openscience
```

The command is `openscience`, and it opens the workspace in your browser. Connect ChatGPT/Codex, your own provider keys, or local models from **Customize → Models**. If you would rather not install it globally, `npx synsci` does the same thing in a single step:

```bash
npx synsci
```

Platform binaries and desktop installers are also attached to [GitHub Releases](https://github.com/synthetic-sciences/OpenScience/releases); see the [changelog](CHANGELOG.md) for what's new in each version. Stable macOS releases are Developer ID signed, notarized, and stapled. A signed stable install can verify the exact architecture-specific release ZIP, replace itself, prove the packaged main process and bundled runtime healthy, and restart without another DMG. Local or ad-hoc-signed development builds are not part of the stable update channel and cannot self-update.

Linux installs require kernel 5.1 or newer. Glibc builds require glibc 2.17 or newer, and musl builds are published separately. CentOS 7's stock 3.10 kernel is not supported even though its glibc version meets the minimum; use a newer host kernel or VM.

## Quickstart

Set an API key from a supported provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, and so on) and start the workspace:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
openscience
```

`openscience` opens the workspace in your browser. Your keys stay on your machine and requests go straight to the provider. You can also run `openscience keys add` to store a key from the terminal, add keys from the Credentials panel, and pick a model from the model selector. To open the workspace in a specific project:

```bash
openscience ~/code/my-project
```

## How it works

OpenScience runs a local server that hosts the workspace UI, the agent runtime, the complete default skill library, and the tool layer. The agent plans with a research harness, calls tools (shell, editor, LSP, MCP servers, scientific connectors, and skills), and streams its work back to the browser. Models are routed per request directly to providers you configure, so you can switch between providers or run local models without changing anything else. Sessions, settings, credentials, skills, artifacts, and provenance are stored on disk.

| Path                 | Contents                                                     |
| -------------------- | ------------------------------------------------------------ |
| `backend/cli`        | The CLI, server, provider integrations, sessions, and skills |
| `frontend/workspace` | The browser workspace UI, served by the CLI                  |
| `frontend/docs`      | The documentation site                                       |
| `tooling/sdk/js`     | The TypeScript SDK                                           |
| `tooling/plugin`     | The plugin runtime                                           |

## Configuration

Global config lives in `~/.config/openscience/openscience.json`. Project config lives in `openscience.json` or a `.openscience/` directory at the repo root. Custom agents, commands, tools, plugins, and themes load from those directories.

## Development

You need [Bun](https://bun.sh) 1.3 or newer.

```bash
bun install
bun dev
bun run typecheck
bun run --cwd backend/cli test
bun run --cwd backend/cli build
```

`bun dev` runs the workspace from source, and `bun run --cwd backend/cli build` produces the platform binaries.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the system fits together, [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute, [AGENTS.md](AGENTS.md) for the style guide, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community standards.

## Security

The permission system keeps you aware of what the agent is doing; it is not an isolation boundary by itself. New local installs start in **Approve for me**: the project is trusted, while commands run inside macOS Seatbelt or Linux bubblewrap containment. The composer’s **Research tools → Action approval** menu can switch to **Ask for approval** (sandboxed and project trust revoked) or deliberately enable **Full access** (trusted project with containment off). An administrator policy may enforce a stricter boundary. The sandbox is not a full jail, so use a container or VM for hostile code. Provider credentials stay out of general subprocess environments, arbitrary Python/R kernels receive a minimal environment, and credential-shaped values are redacted from output. To inspect or verify containment, run `openscience sandbox` and `openscience sandbox test`; to report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

OpenScience is an independent project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, PBC, used here only to describe compatibility.
