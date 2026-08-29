<div align="center">

<img src="assets/wordmark.svg" alt="OpenScience" width="440">

### The open-source AI workbench for scientific research

Give it a goal. It reads the literature, writes and runs code, runs the experiments, and writes up what it found.

<br/>

[![CI](https://github.com/synthetic-sciences/OpenScience/actions/workflows/ci.yml/badge.svg)](https://github.com/synthetic-sciences/OpenScience/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40synsci%2Fopenscience?label=%40synsci%2Fopenscience&color=0d9488)](https://www.npmjs.com/package/@synsci/openscience)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![docs](https://img.shields.io/badge/docs-openscience.sh-0d9488.svg)](https://openscience.sh/docs)

[Install](#install) · [Quickstart](#quickstart) · [Docs](https://openscience.sh/docs) · [Ace](#synthetic-sciences-account-and-ace)

</div>

---

OpenScience is an AI workbench for scientific research. You give it a goal, and it works through the research loop the way a capable collaborator would. It reads the papers that matter, forms a hypothesis, writes and runs code, runs experiments on your compute, queries the major scientific databases, and writes up the result. It runs as a workspace in your browser and works with frontier or open-weight models using your own keys, eligible ChatGPT access, local models, or Ace. A free Synthetic Sciences account links the installation once and keeps research sessions available as an observable trace; Ace remains optional.

It is model-agnostic, open source, and built to do real work in machine learning, biology, physics, and chemistry.

## What it does

- **Runs the whole loop.** Literature review, hypothesis, code, experiment, analysis, and write-up, in one continuous session.
- **One adaptive Research agent.** A single user-facing collaborator handles the task end to end, loads domain skills when useful, and delegates independent Explore or Execute work when it helps. Off, Auto, and High delegation guide how readily it parallelizes without imposing a per-turn worker quota; plan mode stays read-only.
- **309 bundled skills.** Training (DeepSpeed, PEFT, TRL), evaluation, dataset work, molecular and clinical biology, cheminformatics, papers and LaTeX, figures, and user-configured scientific runtimes.
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

The command is `openscience`, and it opens the workspace in your browser. The first launch links a free Synthetic Sciences account and keeps a revocable device credential, so later launches do not repeat browser sign-in. Connect ChatGPT/Codex, your own provider keys, local models, or optional Ace-managed models from **Customize → Models**. If you would rather not install it globally, `npx synsci` does the same thing in a single step:

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

## Synthetic Sciences account and Ace

OpenScience uses a free [Synthetic Sciences account](https://app.syntheticsciences.ai) to connect sessions, settings, and optional synced services. Sign in once and the device keeps a revocable API key, so local, BYOK, and eligible ChatGPT/Codex-backed work does not require repeated browser logins. Ace is the optional pay-as-you-go wallet for credit-backed models routed through OpenRouter and enhanced search.

```bash
openscience login          # connect this device once
openscience wallet         # check Ace and the purchased Wallet balance
```

Ace is one optional on/off authorization, not a scheduled monthly plan. Turning it on is a **$0 authorization** backed by the selected saved card; it does not buy credits or change the Wallet. One credit is $1 shared by credit-backed model calls and enhanced search. Usage is debited at the underlying OpenRouter provider price plus a 2% service margin. While Ace is on, a purchased Wallet balance below **5 credits** triggers one fixed reload of **20 credits** plus the disclosed processing fee. Turning Ace off stops future charges and preserves saved Stripe cards, Wallet value, and billing history. There is no separate auto-reload control. BYOK, local-model, and eligible ChatGPT/Codex usage remain separate and never debit the Wallet.

## How it works

OpenScience runs a local server that hosts the workspace UI, the agent runtime, the complete default skill library, and the tool layer. The agent plans with a research harness, calls tools (shell, editor, LSP, MCP servers, scientific connectors, and skills), and streams its work back to the browser. Models are routed per request, so you can switch between providers or run local models without changing anything else. Sessions, skills, artifacts, and provenance are stored on disk. A connected Synthetic Sciences account adds optional credit-backed models, credential sync, private research graphs, and enhanced search.

| Path                 | Contents                                                     |
| -------------------- | ------------------------------------------------------------ |
| `backend/cli`        | The CLI, server, provider integrations, sessions, and skills |
| `frontend/workspace` | The browser workspace UI, served by the CLI                  |
| `frontend/docs`      | The documentation and session-share site                     |
| `tooling/sdk/js`     | The TypeScript SDK                                           |
| `tooling/plugin`     | The plugin runtime                                           |

## Configuration

Global config lives in `~/.config/openscience/openscience.json`. Project config lives in `openscience.json` or a `.openscience/` directory at the repo root ([schema](https://openscience.sh/config.json)). Custom agents, commands, tools, plugins, and themes load from those directories.

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

The permission system keeps you aware of what the agent is doing; it is not an isolation boundary by itself. New local installs start in **Approve for me**: the project is trusted, while commands run inside macOS Seatbelt or Linux bubblewrap containment. The composer’s **Research tools → Action approval** menu can switch to **Ask for approval** (sandboxed and project trust revoked) or deliberately enable **Full access** (trusted project with containment off). Managed policy may enforce a stricter boundary. The sandbox is not a full jail, so use a container or VM for hostile code. Account and provider credentials stay out of general subprocess environments, arbitrary Python/R kernels receive a minimal environment, and credential-shaped values are redacted from output. **Use my data** is enabled by default after sign-in and uploads the complete research trajectory, including prompts, model responses, tool calls, and results, with credentials redacted. Turn the single setting off to stop uploads and clear pending events; local sessions continue to work. To inspect or verify containment, run `openscience sandbox` and `openscience sandbox test`; to report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

OpenScience is an independent project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, PBC, used here only to describe compatibility.
