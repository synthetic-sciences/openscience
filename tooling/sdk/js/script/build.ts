#!/usr/bin/env bun

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../../backend/cli"))

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
    tsConfigPath: path.join(dir, "tsconfig.json"),
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
      exportFromIndex: false,
    },
    {
      name: "@hey-api/sdk",
      instance: "OpenScienceClient",
      exportFromIndex: false,
      auth: false,
      paramsStructure: "flat",
    },
    {
      name: "@hey-api/client-fetch",
      exportFromIndex: false,
      baseUrl: "http://localhost:4096",
    },
  ],
})

// @hey-api currently drops the Promise returned by ReadableStream.cancel().
// Abort can therefore surface as an unhandled rejection after a caller has
// already stopped consuming SSE. Keep this tiny generated-runtime repair in
// the build so regeneration cannot reintroduce the launcher crash.
const sseRuntime = path.join(dir, "src/v2/gen/core/serverSentEvents.gen.ts")
const generated = await Bun.file(sseRuntime).text()
const settledCancel = generated.replace(
  /const abortHandler = \(\) => \{\s*try \{\s*reader\.cancel\(\);?\s*\} catch \{\s*\/\/ noop\s*\}\s*\};?/,
  "const abortHandler = () => {\n          void reader.cancel().catch(() => undefined)\n        }",
)
if (settledCancel === generated) throw new Error("Generated SSE cancel repair no longer matched @hey-api output")
await Bun.write(sseRuntime, settledCancel)

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc -p tsconfig.build.json`
await $`rm openapi.json`
