# Writing a plugin

A plugin is an async function that receives the running instance and returns
hooks. Plugins can add tools, provider auth methods, and lifecycle hooks; they
run inside the OpenScience host process.

## Shape

The contract is `@synsci/plugin` (`tooling/plugin/src/index.ts`).
`tooling/plugin/src/example.ts` is the smallest complete plugin:

```ts
import type { Plugin } from "@synsci/plugin"
import { tool } from "@synsci/plugin"

export const ExamplePlugin: Plugin = async (ctx) => {
  return {
    tool: {
      mytool: tool({
        description: "This is a custom tool",
        args: { foo: tool.schema.string().describe("foo") },
        async execute(args) {
          return `Hello ${args.foo}!`
        },
      }),
    },
  }
}
```

`ctx` (`PluginInput`) carries `client` (a typed SDK client bound to the local
server), `project`, `directory`, `worktree`, `serverUrl`, and `$` (Bun's shell).

The returned `Hooks` may include:

| Hook                                          | When it runs                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| `tool`                                        | Registers tools by id (see [adding-a-tool.md](adding-a-tool.md)).               |
| `auth`                                        | Adds `oauth` or `api` credential methods for a provider.                        |
| `config`                                      | Once at startup with the effective config.                                      |
| `event`                                       | Every bus event.                                                                |
| `chat.message`, `chat.params`, `chat.headers` | When a new message is received / before model params and headers are finalized. |
| `permission.ask`                              | Before a permission prompt; may set `allow`, `deny`, or `ask`.                  |
| `command.execute.before`                      | Before a slash command runs.                                                    |
| `tool.execute.before`, `tool.execute.after`   | Around every tool call.                                                         |
| `experimental.*`                              | Message, system-prompt, compaction, and text-complete transforms; unstable.     |

Every plugin module export that is a function is initialized, so export one
plugin per module (or a default export) to avoid double registration.

## Installing a plugin

List it in `openscience.json` (global `~/.config/openscience/openscience.json`
or a project's `openscience.json` / `.openscience/openscience.jsonc`):

```jsonc
{
  "plugin": [
    "my-openscience-plugin@1.2.0", // npm package, installed with bun on first run
    "file:///absolute/path/to/plugin.ts", // local module, imported directly
  ],
}
```

npm plugins install into the cache directory (`~/.cache/openscience` by default) with a 30 s timeout so a missing
package can never wedge startup. A plugin that only a project's config lists
counts as project-owned: it loads only after the project is trusted, and it is
refused while the execution sandbox is enabled, because in-process plugins
cannot be isolated by the sandbox. Global plugins have neither restriction.

## Developing in this repo

`tooling/plugin` is a workspace package, so inside the monorepo you can import
`@synsci/plugin` directly and point `openscience.json` at your module with a
`file://` URL. Run `bun dev "$PWD"` from the repo root and check the server log for
`loading plugin`. For a standalone package, `bun add @synsci/plugin` and export
the plugin from your entry module.

Typecheck with `bun run typecheck` (the plugin package is part of the turbo
graph). Backend tests that exercise plugin loading and plugin tools:

```bash
cd backend/cli
bun test --timeout 15000 ./test/plugin
bun test --timeout 15000 ./test/tool/registry.test.ts
```

Plugins do not need to live in this repo. Open an issue first if you think a
plugin should ship as a built-in.

## Observability and optional review

Keep external provenance or phase protocols in opt-in plugins, not a required
runtime dependency. Use `event` and tool hooks to observe execution; use message
transforms only when you deliberately intend to change model input. Record the
session and tool-call identifiers supplied by the host, distinguish observed
events from inferred labels, and test success, failure, cancellation, and replay.
An after-tool callback alone is not a complete failure ledger. Do not claim
exactly-once delivery or signed provenance unless the plugin implements and
verifies those guarantees.

Plugins run with host privileges. Do not export prompts, files, provider headers,
credentials, or raw tool output to a remote tracing service without explicit
consent. Keep queues and timeouts bounded so an unavailable telemetry service
cannot stall a scientific task. Metadata protocols such as those proposed in
issue #103 can evolve independently of the core wire contract.

A review plugin should evaluate citations, artifacts, test results, and stated
conclusions against explicit criteria. A model's displayed reasoning is not
proof of correctness. A blocking reviewer (issue #141) needs a separate design:
which actions it can block, a bounded latency and spend budget, treatment of
unavailable evidence, visible reasons, and recovery. Existing observation hooks
do not by themselves implement a safe accept/reject gate.
