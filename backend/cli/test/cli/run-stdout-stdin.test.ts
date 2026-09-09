import { expect, test } from "bun:test"
import { pipedInput, stdout } from "../../src/cli/cmd/run"

const runModule = new URL("../../src/cli/cmd/run.ts", import.meta.url).pathname

test("run output written just before process.exit still reaches a slow consumer", async () => {
  // A subprocess is the honest check: process.exit right after a large
  // async stdout write used to drop the tail, including the `done` line every
  // parser needs. The blocking writer returns only once the pipe has it.
  const script = [
    `const { stdout } = await import(${JSON.stringify(runModule)})`,
    `stdout.write("x".repeat(4 * 1024 * 1024) + "\\n")`,
    `stdout.write(JSON.stringify({ type: "done" }) + "\\n")`,
    `process.exit(0)`,
  ].join("\n")
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
  // Read late so the pipe is full while the child wants to exit.
  await Bun.sleep(300)
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(err).toBe("")
  expect(code).toBe(0)
  expect(out.length).toBe(4 * 1024 * 1024 + 1 + '{"type":"done"}'.length + 1)
  expect(out.trimEnd().split("\n").at(-1)).toBe('{"type":"done"}')
  expect(typeof stdout.write).toBe("function")
})

test("pipedInput appends closed stdin and explains an open pipe when a message was given", async () => {
  const warnings: string[] = []
  const closed = await pipedInput(true, {
    isTTY: false,
    text: async () => "diff",
    warn: (m) => warnings.push(m),
    graceMs: 50,
  })
  expect(closed).toBe("diff")
  expect(warnings).toEqual([])

  const open = Promise.withResolvers<string>()
  const pending = pipedInput(true, {
    isTTY: false,
    text: () => open.promise,
    warn: (m) => warnings.push(m),
    graceMs: 20,
  })
  await Bun.sleep(60)
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain("/dev/null")
  open.resolve("late")
  expect(await pending).toBe("late")

  expect(
    await pipedInput(true, { isTTY: true, text: async () => "never", warn: (m) => warnings.push(m) }),
  ).toBeUndefined()
  // Without a message the pipe is the message; no hint is printed.
  const quiet = await pipedInput(false, {
    isTTY: false,
    text: async () => "only",
    warn: (m) => warnings.push(m),
    graceMs: 1,
  })
  expect(quiet).toBe("only")
  expect(warnings).toHaveLength(1)
})
