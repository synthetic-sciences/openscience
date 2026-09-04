# Adding a tool

Tools are what the agent calls. There are three ways to add one, from most to
least invasive:

| Kind         | Lives in                                                           | Ships to users           | Trust gate                                     |
| ------------ | ------------------------------------------------------------------ | ------------------------ | ---------------------------------------------- |
| Built-in     | `backend/cli/src/tool/<name>.ts` + `registry.ts`                   | Every install            | None (reviewed code)                           |
| Project tool | `.openscience/tool/*.ts` or `.openscience/tools/*.ts` in a project | That project only        | Project must be trusted (`project_plugin`)     |
| Plugin tool  | A package that exports a `Plugin`                                  | Whoever lists the plugin | See [writing-a-plugin.md](writing-a-plugin.md) |

Prefer a project tool or plugin unless the tool should exist for everyone.

## Built-in tools

Define the tool with `Tool.define` from `backend/cli/src/tool/tool.ts`:

```ts
import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./hello.txt"

export const HelloTool = Tool.define("hello", {
  description: DESCRIPTION,
  parameters: z.object({
    name: z.string().describe("Who to greet"),
  }),
  async execute(params, ctx) {
    await ctx.ask({ permission: "hello", patterns: [params.name], always: ["*"], metadata: {} })
    return { title: `Hello ${params.name}`, metadata: {}, output: `Hello ${params.name}!` }
  },
})
```

- `parameters` is the public contract. `Tool.validate` runs it at the provider
  boundary and again in `execute`, so defaults and transforms behave the same
  for direct and delegated calls. Add `normalizeInput` / `formatValidationError`
  only when a model reliably sends a malformed shape.
- Keep the description in a sibling `.txt` file; it is the model's only
  documentation. Say what the tool does, when to use it, and when not to.
- Call `ctx.ask(...)` before any side effect so the permission system can
  prompt or deny. `ctx.abort` is the session's abort signal.
- Output is truncated automatically; return `metadata.truncated` yourself only
  if the tool manages its own limits.
- Add it to the `all()` list in `backend/cli/src/tool/registry.ts`; agent
  permissions and client flags filter that list per session.

Plan mode is fail-closed: `backend/cli/src/tool/plan-mode.ts` blocks every tool
the `plan` agent calls unless its id is in the `SAFE` set. Leave a new tool out
of that set unless its complete execution path is read-only and free, and add
a case to `test/tool/plan-mode.test.ts` when you do add one.

Tests live in `backend/cli/test/tool/`. Add one that calls `execute` through
`Tool.define` with real inputs (no mocks) and run:

```bash
cd backend/cli
bun test --timeout 15000 ./test/tool/registry.test.ts ./test/tool/plan-mode.test.ts
bun test --timeout 15000 ./test/tool/<your-tool>.test.ts
```

## Project tools

Any `.ts` or `.js` file under `.openscience/tool/` or `.openscience/tools/`
(project) or the same directories under the global config dir becomes a tool.
The file's default export becomes a tool named after the file; named exports
become `<file>_<export>`:

```ts
// .openscience/tool/hello.ts
import { tool } from "@synsci/plugin"

export default tool({
  description: "Greets someone",
  args: { name: tool.schema.string().describe("Who to greet") },
  async execute(args) {
    return `Hello ${args.name}!`
  },
})
```

A plain object with `description`, `args`, and `execute` works without the
import; `tool()` only adds types. `execute` receives a context with
`sessionID`, `directory`, `worktree`, `abort`, and `ask`.

Importing the module runs its top-level code in the OpenScience host process,
so project-owned tools load only after the project is trusted
(`ProjectTrust.require(..., "project_plugin")`), and revoking trust evicts them
from the registry. `test/tool/registry.test.ts` ("loads tools from
.openscience/tool") shows the exact fixture shape.

## Plugin tools

A plugin's `tool` hook returns the same `ToolDefinition` shape keyed by tool
id, and the registry loads it through the same `fromPlugin` path as project
tools. See [writing-a-plugin.md](writing-a-plugin.md).
