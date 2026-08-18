# Cross-harness evaluation runner

This runner executes one frozen launch flow in separate workspaces through OpenScience,
Claude Code, and DeepSeek Harness. It captures versions, exact argv, prompt hashes, exit
status, redacted stdout/stderr, expected artifact hashes, and the resulting git diff
fingerprint. It never scores its own output.

## Prerequisites

- `openscience` authenticated with the model selected by `--openscience-model`
- `claude` authenticated locally
- `dsh` authenticated with a DeepSeek API key

DeepSeek Harness is pinned for this adapter at release `0.1.0-rc.7`, commit
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`:

```sh
npm install -g @deepseek-ai/dsh@0.1.0-rc.7
```

The implementation follows the upstream headless profile contract. No DeepSeek Harness
source is vendored or copied into OpenScience.

## Usage

```sh
bun evals/harness/run.ts --list
bun evals/harness/run.ts --help

bun evals/harness/run.ts \
  --flow python-csv-report \
  --openscience-model openai-codex/gpt-5.6-sol \
  --claude-model opus
```

Use `--dry-run` to validate installations and inspect the commands without invoking a
model. Limit the matrix with `--harnesses openscience,deepseek-harness`. Runs are
sequential by default; `--parallel` is available when provider limits allow it.
Held-out flows require the explicit `--include-held-out` flag.
Binary overrides are available as `--openscience-bin`, `--claude-code-bin`, and
`--deepseek-harness-bin` for local builds and pinned toolchains.

Each harness receives a clean git workspace with only the selected fixtures and a
`BENCHMARK.md` setup note. Claude Code uses `bypassPermissions` only inside that disposable
workspace. Treat benchmark prompts as trusted code-execution inputs. External credentials
and application-level session stores remain owned by their respective CLIs.

The launch suite includes flows that require manual infrastructure or permission behavior.
The runner records those setup constraints but does not pretend to provision SSH targets,
network denials, or UI state. Such runs require operator review and remain unscored.

## Upstream references

- [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/docs/architecture.md)
- [DeepSeek Harness CLI contract](https://github.com/deepseek-ai/deepseek-harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/apps/cli/reference/README.md)
- [Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
