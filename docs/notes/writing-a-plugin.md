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
The client is bound to the instance's project and directory. `signal` is aborted
when the host unloads the plugin; pass it to background requests you own. Older
hosts may not supply that optional field.

The returned `Hooks` may include:

| Hook                                          | When it runs                                                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tool`                                        | Registers tools by id (see [adding-a-tool.md](adding-a-tool.md)).                                     |
| `connector`                                   | Adds scientific sources to this instance's `science_list_dbs`, `science_search`, and `science_fetch`. |
| `dispose`                                     | Releases resources on shutdown or invalidation, after the host aborts `signal`.                       |
| `auth`                                        | Adds `oauth` or `api` credential methods for a provider.                                              |
| `config`                                      | Once at startup with the effective config.                                                            |
| `event`                                       | Every bus event.                                                                                      |
| `chat.message`, `chat.params`, `chat.headers` | When a new message is received / before model params and headers are finalized.                       |
| `permission.ask`                              | Before a permission prompt; may set `allow`, `deny`, or `ask`.                                        |
| `command.execute.before`                      | Before a slash command runs.                                                                          |
| `tool.execute.before`, `tool.execute.after`   | Around every tool call.                                                                               |
| `experimental.*`                              | Message, system-prompt, compaction, and text-complete transforms; unstable.                           |

Export only plugin functions from the entry module; put helpers in other files.
Exporting the same function both by name and as default initializes it once.

## Return a scientific result

A tool may still return a string. It can also return an object:

```ts
return {
  title: "Sample summary",
  output: "Three observations; mean 2.",
  metadata: { count: 3, mean: 2, method: "arithmetic mean" },
  attachments: [
    {
      type: "file",
      mime: "text/csv",
      filename: "summary.csv",
      url: "data:text/csv,count%2Cmean%0A3%2C2%0A",
    },
  ],
}
```

`output` is required; `title`, JSON-serializable `metadata`, and `attachments`
are optional. Each attachment requires `type: "file"`, `mime`, and an absolute
`data:`, `http:`, `https:`, or `file:` URL. The host assigns part, session and
message IDs; supplying those fields is rejected. Tool context also includes an
optional `callID` for correlating a real invocation.

The host validates results and truncates text while preserving title, metadata,
and attachments. It owns the `metadata.truncated` and `metadata.outputPath`
fields. Attachments do not bypass file access policy, fetch remote content, or
save versioned artifacts. Use the artifact/job APIs for persistent resources and
include their returned references in metadata; a string that looks like an ID
does not create or authorize access to that resource. Keep attachment bodies
small and reference large saved files instead of embedding them in messages.

## Contribute a scientific source

Import `Connector` from `@synsci/plugin` and return `connector: [source]` with
your hooks. It is the same type used by the built-in connector registry. A source
provides an ID, name, domain, description, `search`, and `fetch`; optional
`formats` and `fetchFile` support file representations. Honor the caller's abort
signal, limits, and your service's usage rules. Plugins own any HTTP transport,
credential handling and rate limiting they require.

Contributions are composed per project instance, so they cannot leak into
another project's catalog. IDs must be lowercase words separated by hyphens and
must not collide with built-in or other plugin sources. The host checks project
trust at invocation, including retained connector references after revocation.
These checks do not turn host-process JavaScript into sandboxed code.

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

## Resource lifecycle

Return `dispose: async () => { ... }` to close connections, watchers, queues or
timers. It runs when an instance closes or its plugin cache is invalidated.
If a later plugin fails initialization, hooks already initialized are disposed too.
Dispose is best effort, bounded to five seconds per plugin, and failures are
logged. The host first aborts `signal`; a plugin must cooperate with cancellation
because JavaScript already running in the host cannot be forcibly isolated.
Keep cleanup idempotent and avoid starting new work during disposal.

Repeated host initialization does not add duplicate event subscriptions. Event
callbacks are observations and are not awaited as durable business processing;
exceptions are logged. Use the runtime SDK's replayable stream for a separate
application that needs reconnect and delivery recovery.

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

Installed plugin and custom tool IDs participate in the normal Research tool
selection without a built-in name whitelist. Configured denies still apply before
initialization; fresh direct answers and explicit local read-only inspection keep
their existing narrow tool sets. The host integration test at
`backend/cli/test/plugin/runtime.test.ts` copies a deterministic test-only plugin
outside the project and loads it through the public plugin package with
the execution sandbox enabled, executes it through the public HTTP runtime and a
deterministic local provider, verifies its rich result through the messages API,
checks a configured denial, and checks removal from discovery after uninstall.
