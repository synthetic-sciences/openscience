import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import yargs from "yargs"
import { cmd, disposeDataRootOperation, runDataRootMiddleware } from "@/cli/cmd/cmd"
import { DataRoot } from "@/global/data-root"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { tmpdir } from "../fixture/fixture"

async function waitForFile(filepath: string) {
  const deadline = Date.now() + 2_000
  while (!(await Bun.file(filepath).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filepath}`)
    await Bun.sleep(10)
  }
}

async function markers(config: string) {
  return fs.readdir(path.join(config, "data-root-operations")).catch(() => [] as string[])
}

afterEach(async () => {
  await disposeDataRootOperation().catch(() => undefined)
})

test("a string option before the command still scopes parsed middleware and the complete handler", async () => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "config")
  const managed = await DataRoot.ensure(config, path.join(tmp.path, "data"), false)
  DataRootBarrier.configure({ root: managed.path, config })
  const handlerReady = Promise.withResolvers<void>()
  const startNested = Promise.withResolvers<void>()
  const nestedReady = Promise.withResolvers<void>()
  let middlewareCommand: string | undefined

  const command = cmd<{}, { model?: string }>({
    command: "run",
    builder: (parser) => parser.option("model", { type: "string" }),
    handler: async (args) => {
      expect(args.model).toBe("provider/model")
      handlerReady.resolve()
      await startNested.promise
      await using nested = await DataRootBarrier.enter(path.join(managed.path, "nested.json"), 2_000)
      nestedReady.resolve()
      void nested
    },
  })
  const parser = yargs(["--model", "provider/model", "run"])
    .exitProcess(false)
    .middleware(async (args) => {
      middlewareCommand = typeof args._[0] === "string" ? args._[0] : undefined
      await runDataRootMiddleware(middlewareCommand, managed.path, async () => undefined, 2_000)
    })
    .command(command)
    .strict()
  const parsing = Promise.resolve(parser.parse())
  let switching: Promise<AsyncDisposable> | undefined

  try {
    await handlerReady.promise
    expect(middlewareCommand).toBe("run")
    switching = DataRootBarrier.exclusive(2_000)
    await waitForFile(path.join(config, "data-root-switch.intent"))
    startNested.resolve()
    expect(await Promise.race([nestedReady.promise.then(() => true), Bun.sleep(250).then(() => false)])).toBe(true)
    await parsing
    expect(await Promise.race([switching.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
    await disposeDataRootOperation()
    const exclusive = await switching
    await exclusive[Symbol.asyncDispose]()
  } finally {
    startNested.resolve()
    await parsing.catch(() => undefined)
    await disposeDataRootOperation().catch(() => undefined)
    const exclusive = await switching?.catch(() => undefined)
    await exclusive?.[Symbol.asyncDispose]()
  }
})

test("shell completion is classified as a short-lived data-root command", async () => {
  await using tmp = await tmpdir()
  const config = path.join(tmp.path, "config")
  const managed = await DataRoot.ensure(config, path.join(tmp.path, "data"), false)
  DataRootBarrier.configure({ root: managed.path, config })

  await runDataRootMiddleware("completion", managed.path, async () => {
    expect(await markers(config)).toHaveLength(1)
  })
  expect(await markers(config)).toHaveLength(1)
  await disposeDataRootOperation()
  expect(await markers(config)).toHaveLength(0)
})

for (const [canonical, alias] of [
  ["tools", "mcp"],
  ["model", "models"],
  ["keys", "auth"],
] as const) {
  test(`top-level alias ${alias} receives the same complete data-root scope as ${canonical}`, async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "config")
    const managed = await DataRoot.ensure(config, path.join(tmp.path, "data"), false)
    DataRootBarrier.configure({ root: managed.path, config })
    const handlerReady = Promise.withResolvers<void>()
    const startNested = Promise.withResolvers<void>()
    const nestedReady = Promise.withResolvers<void>()
    let middlewareCommand: string | undefined

    const command = cmd({
      command: canonical,
      aliases: [alias],
      handler: async () => {
        handlerReady.resolve()
        await startNested.promise
        await using nested = await DataRootBarrier.enter(path.join(managed.path, `${alias}.json`), 2_000)
        nestedReady.resolve()
        void nested
      },
    })
    const parser = yargs([alias])
      .exitProcess(false)
      .middleware(async (args) => {
        middlewareCommand = typeof args._[0] === "string" ? args._[0] : undefined
        await runDataRootMiddleware(middlewareCommand, managed.path, async () => undefined, 2_000)
      })
      .command(command)
      .strict()
    const parsing = Promise.resolve(parser.parse())
    let switching: Promise<AsyncDisposable> | undefined

    try {
      await handlerReady.promise
      expect(middlewareCommand).toBe(alias)
      switching = DataRootBarrier.exclusive(2_000)
      await waitForFile(path.join(config, "data-root-switch.intent"))
      startNested.resolve()
      expect(await Promise.race([nestedReady.promise.then(() => true), Bun.sleep(250).then(() => false)])).toBe(true)
      await parsing
      expect(await Promise.race([switching.then(() => true), Bun.sleep(50).then(() => false)])).toBe(false)
      await disposeDataRootOperation()
      const exclusive = await switching
      await exclusive[Symbol.asyncDispose]()
    } finally {
      startNested.resolve()
      await parsing.catch(() => undefined)
      await disposeDataRootOperation().catch(() => undefined)
      const exclusive = await switching?.catch(() => undefined)
      await exclusive?.[Symbol.asyncDispose]()
    }
  })
}
