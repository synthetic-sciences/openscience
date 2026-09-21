import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { servicePort } from "../../../../frontend/desktop/src/service-port.mjs"

async function scratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-port-"))
  return { file: path.join(dir, "service-port.json"), [Symbol.asyncDispose]: () => fs.rm(dir, { recursive: true }) }
}

function hold(port: number) {
  return new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer().on("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}

test("the runtime keeps its port across launches, so the window keeps its origin and what it stored there", async () => {
  await using tmp = await scratch()
  const first = await servicePort(tmp.file)
  expect(first).toBeGreaterThan(1023)
  expect(JSON.parse(await fs.readFile(tmp.file, "utf8"))).toEqual({ port: first })
  expect(await servicePort(tmp.file)).toBe(first)
  expect(await servicePort(tmp.file)).toBe(first)
})

test("a remembered port something else now holds is replaced, and the replacement is remembered", async () => {
  await using tmp = await scratch()
  const first = await servicePort(tmp.file)
  const squatter = await hold(first)
  try {
    const moved = await servicePort(tmp.file)
    expect(moved).not.toBe(first)
    expect(JSON.parse(await fs.readFile(tmp.file, "utf8"))).toEqual({ port: moved })
  } finally {
    await new Promise((resolve) => squatter.close(resolve))
  }
})

test("a damaged or out-of-range record falls back to a free port", async () => {
  await using tmp = await scratch()
  for (const content of ["not json", JSON.stringify({ port: 80 }), JSON.stringify({ port: "4096" }), "{}"]) {
    await fs.writeFile(tmp.file, content)
    const selected = await servicePort(tmp.file)
    expect(selected).toBeGreaterThan(1023)
    expect(JSON.parse(await fs.readFile(tmp.file, "utf8"))).toEqual({ port: selected })
  }
})
