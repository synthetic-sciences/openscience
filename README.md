<div align="center">

```
          ██████╗ ██████╗ ███████╗███╗   ██╗
         ██╔═══██╗██╔══██╗██╔════╝████╗  ██║
         ██║   ██║██████╔╝█████╗  ██╔██╗ ██║
         ██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║
         ╚██████╔╝██║     ███████╗██║ ╚████║
          ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝
███████╗ ██████╗██╗███████╗███╗   ██╗ ██████╗███████╗
██╔════╝██╔════╝██║██╔════╝████╗  ██║██╔════╝██╔════╝
███████╗██║     ██║█████╗  ██╔██╗ ██║██║     █████╗
╚════██║██║     ██║██╔══╝  ██║╚██╗██║██║     ██╔══╝
███████║╚██████╗██║███████╗██║ ╚████║╚██████╗███████╗
╚══════╝ ╚═════╝╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝╚══════╝
```

### The open-source AI co-scientist

Give it a goal. It reads the literature, writes and runs code, runs the experiments, and writes up what it found.

<br/>

[![CI](https://github.com/synthetic-sciences/OpenScience/actions/workflows/ci.yml/badge.svg)](https://github.com/synthetic-sciences/OpenScience/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40synsci%2Fopenscience?label=%40synsci%2Fopenscience&color=0d9488)](https://www.npmjs.com/package/@synsci/openscience)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![docs](https://img.shields.io/badge/docs-syntheticsciences.ai-0d9488.svg)](https://syntheticsciences.ai/docs)

[Install](#install) · [Quickstart](#quickstart) · [Docs](https://syntheticsciences.ai/docs) · [Benchmarks](#benchmarks) · [Atlas](#atlas)

</div>

---

OpenScience is an AI agent for research. You give it a goal, and it works through the research loop the way a capable collaborator would. It reads the papers that matter, forms a hypothesis, writes and runs code, runs experiments on real compute, queries the major scientific databases, and writes up the result. It runs as a workspace in your browser and works with any frontier or open-weight model from Anthropic, OpenAI, Google, and dozens of other providers, using your own API keys. No account is required.

It is model-agnostic, open source, and built to do real work in machine learning, biology, physics, and chemistry.

## What it does

- **Runs the whole loop.** Literature review, hypothesis, code, experiment, analysis, and write-up, in one continuous session.
- **Research agents.** A `research` agent by default, plus `biology`, `physics`, and `ml` specialists, with critique and literature-review sub-agents and a read-only plan mode.
- **250+ skills.** Training (DeepSpeed, PEFT, TRL), evaluation, dataset work, molecular and clinical biology, cheminformatics, papers and LaTeX, figures, and cloud compute (Modal, Tinker, and others).
- **Scientific databases as tools.** UniProt, PDB, Ensembl, ChEMBL, PubChem, arXiv, OpenAlex, Semantic Scholar, and around 30 more, queryable directly by the agent.
- **A real workspace.** A browser UI with a file tree, an editor, a terminal, session history, and inline rendering for molecules, structures, genomes, and plots.
- **Extensible.** LSP integration, MCP servers, plugins, custom agents and commands, and a TypeScript SDK.

## Install

Install and open the workspace with one command:

```bash
npx synsci
```

Or install directly:

```bash
npm install -g @synsci/openscience                                # the command is: openscience
curl -fsSL https://syntheticsciences.ai/install | bash    # installer script
```

Platform binaries are attached to [GitHub Releases](https://github.com/synthetic-sciences/OpenScience/releases).

## Quickstart

Set a key from any provider and start the workspace:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or OPENAI_API_KEY, GEMINI_API_KEY, and so on
openscience
```

`openscience` opens the workspace in your browser. Your keys stay on your machine and requests go straight to the provider. You can also add keys from the Credentials panel and pick a model from the model selector. To open the workspace in a specific project:

```bash
openscience ~/code/my-project
```

## Benchmarks

We are evaluating OpenScience on end-to-end research tasks: reproducing published results, improving a metric under a fixed compute budget, and answering questions grounded in the scientific literature. We will publish the numbers and the evaluation harness here soon.

| Task suite | Description | Result |
| --- | --- | --- |
| Reproduction | Reproduce a published result from its paper and repo | Coming soon |
| Optimization | Improve a target metric under a fixed budget | Coming soon |
| Literature QA | Answer grounded questions over the scientific literature | Coming soon |

## Atlas

[Atlas](https://app.syntheticsciences.ai) is Synthetic Sciences' managed platform. It gives you a curated set of frontier models billed from a prepaid wallet, so you do not need per-provider keys, plus a persistent research graph and cloud compute. OpenScience works with Atlas but never requires it.

```bash
openscience connect login
```

Bring-your-own-key usage is always free and is never gated. Atlas only meters the models it serves.

## How it works

OpenScience runs a local server that hosts the workspace UI, the agent runtime, and the tool layer. The agent plans with a research harness, calls tools (shell, editor, LSP, MCP servers, scientific connectors, and skills), and streams its work back to the browser. Models are routed per request, so you can switch between providers or run local models without changing anything else. Sessions, artifacts, and provenance are stored on disk and can be shared as links.

| Path | Contents |
| --- | --- |
| `backend/cli` | The CLI, server, provider integrations, sessions, and skills |
| `frontend/app` | The workspace UI, served by the CLI |
| `frontend/web` | The documentation and session-share site |
| `tooling/sdk/js` | The TypeScript SDK |
| `tooling/plugin` | The plugin runtime |
| `integrations/vscode` | The VS Code integration |

## Configuration

Global config lives in `~/.config/openscience/openscience.json`. Project config lives in `openscience.json` or a `.openscience/` directory at the repo root ([schema](https://syntheticsciences.ai/config.json)). Custom agents, commands, tools, plugins, and themes load from those directories.

## Development

You need [Bun](https://bun.sh) 1.3 or newer.

```bash
bun install
bun dev                            # run the CLI from source
bun run typecheck
bun run --cwd backend/cli test
bun run --cwd backend/cli build    # build platform binaries
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the system fits together, [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute, [AGENTS.md](AGENTS.md) for the style guide, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community standards.

## Security

The agent is not sandboxed. The permission system keeps you aware of what the agent is doing; it is not an isolation boundary. Run inside a container or VM if you need isolation. Provider and synced credentials are filtered out of subprocess environments and redacted from output. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

OpenScience is an independent project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, PBC, used here only to describe compatibility.
