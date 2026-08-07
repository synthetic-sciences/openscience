# @synsci/openscience

OpenScience is a model-agnostic, open-source AI research agent for scientific and ML engineering work. It runs a workspace in your browser where the agent plans tasks, writes and runs code, drives experiments, queries scientific databases, and writes up results. Bring your own API key or sign in with Atlas, use any frontier or open-weight model, and work with the bundled science skills.

Part of the [OpenScience](https://github.com/synthetic-sciences/OpenScience) repository.

## Install

```bash
npm install -g @synsci/openscience
```

The command is `openscience`.

On Linux, the bundled runtime requires kernel 5.1 or newer. Glibc binaries require glibc 2.17 or newer; separate musl packages are selected automatically. CentOS 7's stock 3.10 kernel is unsupported. On Linux ARM64, Bun-compiled executables currently require a 4 KB kernel page size; 16 KB and 64 KB page kernels fail early with a clear diagnostic while [upstream support](https://github.com/oven-sh/bun/issues/17627) remains open.

## Quick start

```bash
openscience                     # open the workspace in your browser
openscience ~/code/project      # open it in a specific directory
openscience connect             # connect a ChatGPT / Codex subscription locally
openscience login               # sign in to Atlas (optional; BYOK works without an account)
openscience run "..."           # run a one-shot task
```

Configuration lives in `~/.config/openscience/openscience.json`. Provider keys can be set in the workspace (bring your own key) or synced from Atlas. Default, learned, installed, and project skills are all local and work without Atlas.

## Docs

See the [repository README](https://github.com/synthetic-sciences/OpenScience#readme) for the full layout, provider setup, agent and skill architecture, and contribution guide.

## License

Apache License 2.0. See [LICENSE](https://github.com/synthetic-sciences/OpenScience/blob/main/LICENSE). Not affiliated with Anthropic.
