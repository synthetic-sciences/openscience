<div align="center">

<img src="assets/wordmark.svg" alt="OpenScience" width="440">

### The open-source AI workbench for scientific research

Give it a goal. It reads the literature, writes and runs code, runs the experiments, and writes up what it found.

<br/>

[![CI](https://github.com/synthetic-sciences/OpenScience/actions/workflows/ci.yml/badge.svg)](https://github.com/synthetic-sciences/OpenScience/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40synsci%2Fopenscience?label=%40synsci%2Fopenscience&color=0d9488)](https://www.npmjs.com/package/@synsci/openscience)
[![release](https://img.shields.io/github/v/release/synthetic-sciences/OpenScience?label=release&color=0d9488)](https://github.com/synthetic-sciences/OpenScience/releases/latest)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

[Get started](#get-started) · [Documentation](#documentation) · [Releases](#releases-and-updates) · [Contributing](CONTRIBUTING.md)

</div>

---

OpenScience is an open-source workbench for scientific research. Work through literature, data, code, experiments, and writing in the desktop app, browser workspace, or terminal.

Choose **Ace** for managed models and research search, connect **your own API keys or supported provider sign-in**, or use **local models**. An OpenScience account is optional for your own provider access and local models.

## Get started

[Download the desktop app](https://openscience.sh/download) for macOS, Windows, or Linux. For the CLI and browser workspace:

```bash
npm install -g @synsci/openscience
openscience
```

Or use the one-step launcher:

```bash
npx synsci
```

Open **Customize → Models** to choose access. For an existing project:

```bash
openscience ~/research/my-project
```

Follow the [quickstart](https://openscience.sh/docs/#/openscience/quickstart) for your first task, or the [installation guide](https://openscience.sh/docs/#/openscience/installation) for platform details and updates.

## Choose model access

| Option        | Setup                                                      | Usage                                     |
| ------------- | ---------------------------------------------------------- | ----------------------------------------- |
| Ace           | Sign in, choose a funding workspace, and fund its Wallet.  | Pay as you go; no monthly subscription.   |
| Your provider | Connect an API key or supported sign-in.                   | Your provider's access and billing terms. |
| Local model   | Connect Ollama, LM Studio, or another compatible endpoint. | Your hardware; no Ace model charge.       |

Ace activation is a $0 authorization. While automatic reloads are enabled, a purchased Wallet balance below $5 triggers a $20 reload; payment-processing fees are disclosed separately before payment. Changing to your own provider does not turn off automatic reloads. See [Pricing and usage](https://openscience.sh/docs/#/openscience/pricing).

Connect from the terminal:

```bash
openscience keys add
openscience models
```

For a local endpoint:

```bash
openscience local add
```

See [Models](https://openscience.sh/docs/#/openscience/models) and [Local models](https://openscience.sh/docs/#/openscience/local-models).

## Give it a research task

```text
Inspect data/samples.csv for missing values and inconsistent labels.
Keep the original data unchanged. Save a quality report and a plot
in results/, with the code needed to reproduce them.
```

Use Research for execution, or start with `/plan` to agree on the method. Review sources, assumptions, code, and outputs before relying on a scientific conclusion.

For a single terminal turn:

```bash
openscience run "Review the analysis plan in this project"
openscience run --continue "Suggest checks for the assumptions you identified"
```

## What you can do

- **Review literature:** search scientific sources, compare findings, and save cited evidence.
- **Analyze data:** inspect inputs, write and run analysis code, and produce figures and reports.
- **Reproduce experiments:** agree on a claim, prerequisites, and budget, then compare measured results.
- **Use scientific capabilities:** inspect available tools and connect your own resources where needed.
- **Reuse procedures:** browse hundreds of bundled skills or add a project-specific workflow.
- **Extend the workbench:** add MCP connections, custom agents and commands, plugins, or an SDK integration.

A skill describes a procedure; it does not mean every referenced tool or service is installed. Check availability in Customize before a substantial task.

## Documentation

Browse the [capability map](https://openscience.sh/docs/#/openscience/capabilities), [Explore tools](https://openscience.sh/docs/#/openscience/explore-tools), and [Skills directory](https://openscience.sh/docs/#/openscience/skill-library). Each catalog explains what an entry does and links to setup or usage instructions. The [workflow cookbook](https://openscience.sh/docs/#/openscience/workflow-examples) provides complete requests with expected deliverables.

| Topic              | Guide                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First use          | [Quickstart](https://openscience.sh/docs/#/openscience/quickstart), [Workspace](https://openscience.sh/docs/#/openscience/workspace)                                                                                                                                                              |
| Models and billing | [Models](https://openscience.sh/docs/#/openscience/models), [Ace](https://openscience.sh/docs/#/openscience/ace), [Pricing](https://openscience.sh/docs/#/openscience/pricing)                                                                                                                    |
| Research           | [Literature reviews](https://openscience.sh/docs/#/openscience/literature-review), [Data analysis](https://openscience.sh/docs/#/openscience/data-analysis), [Reproduction](https://openscience.sh/docs/#/openscience/reproduction), [Writing](https://openscience.sh/docs/#/openscience/writing) |
| Capabilities       | [Skills](https://openscience.sh/docs/#/openscience/skill-library), [Databases](https://openscience.sh/docs/#/openscience/databases), [Connectors](https://openscience.sh/docs/#/openscience/connectors)                                                                                           |
| Customize          | [Project instructions](https://openscience.sh/docs/#/openscience/instructions), [Configuration](https://openscience.sh/docs/#/openscience/configuration)                                                                                                                                          |
| Automate           | [CLI reference](https://openscience.sh/docs/#/openscience/commands), [JSON output](https://openscience.sh/docs/#/openscience/automation), [SDK and editors](https://openscience.sh/docs/#/openscience/extensions)                                                                                 |
| Help               | [Troubleshooting](https://openscience.sh/docs/#/openscience/troubleshooting), [FAQ](https://openscience.sh/docs/#/openscience/faq)                                                                                                                                                                |

Plain-text documentation is available at [llms.txt](https://openscience.sh/docs/llms.txt) and [llms-full.txt](https://openscience.sh/docs/llms-full.txt).

## Releases and updates

[GitHub Releases](https://github.com/synthetic-sciences/openscience/releases) contains desktop installers, CLI archives, checksums, and release notes. The [changelog](CHANGELOG.md) records notable behavior changes.

Use the app's update controls or `openscience upgrade` for the CLI. An npm installation can be updated with `npm install -g @synsci/openscience@latest`. Back up important project files independently of application updates.

## Development

Use the pinned Bun version from `package.json`:

```bash
bun run setup
bun dev
bun run check
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the development loop and required checks. [ARCHITECTURE.md](ARCHITECTURE.md) maps the codebase, and [AGENTS.md](AGENTS.md) describes repository conventions.

For docs changes, see the [docs contributor guide](frontend/docs/README.md) and [documentation source map](docs/notes/documentation-map.md).

## Control and support

Use the [approval controls](https://openscience.sh/docs/#/openscience/permissions) to decide when OpenScience should ask before acting. Keep original inputs, review consequential actions, and use account controls for spending limits.

Report reproducible product bugs in [GitHub Issues](https://github.com/synthetic-sciences/openscience/issues). Use account support for private billing questions. Follow [SECURITY.md](SECURITY.md) to report a vulnerability.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

OpenScience is an independent project. It is not affiliated with, endorsed by, or sponsored by Anthropic. "Claude" is a trademark of Anthropic, PBC, used here only to describe compatibility.
