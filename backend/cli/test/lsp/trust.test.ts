import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Sandbox } from "../../src/sandbox/sandbox"
import { sandboxedExecution, tmpdir } from "../fixture/fixture"

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

test("globally installed language servers cannot start in an untrusted project", async () => {
  await using _sandbox = await sandboxedExecution()
  await using tmp = await tmpdir()
  const bin = path.join(tmp.path, "host-bin")
  const project = path.join(tmp.path, "project")
  const marker = path.join(project, "lsp-started")
  const escaped = path.join(tmp.path, "lsp-escaped")
  const source = path.join(project, "probe.rb")
  const server = path.join(bin, "rubocop")
  const sourceFixture = path.join(import.meta.dir, "..", "fixture", "lsp", "fake-lsp-server.js")
  const fixture = path.join(bin, "fake-lsp-server.js")
  await fs.mkdir(bin, { recursive: true })
  await fs.mkdir(project, { recursive: true })
  await fs.copyFile(sourceFixture, fixture)
  await Bun.write(path.join(project, "Gemfile"), 'source "https://rubygems.org"\n')
  await Bun.write(source, "puts :ok\n")
  await Bun.write(
    server,
    `#!/bin/sh\nprintf escaped > ${quote(escaped)}\nprintf started > ${quote(marker)}\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
  )
  await fs.chmod(server, 0o700)

  const original = process.env.PATH
  process.env.PATH = `${bin}${path.delimiter}${original ?? ""}`
  try {
    await Instance.provide({
      directory: project,
      fn: async () => {
        await ProjectTrust.update(Instance.project, { trusted: false })
        expect((await ProjectTrust.status(Instance.project)).canExecuteProjectCode).toBe(false)
        await LSP.touchFile(source)
        await Bun.sleep(50)
        expect(await Bun.file(marker).exists()).toBe(false)

        const status = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
        await LSP.touchFile(source)
        expect(await Bun.file(marker).exists()).toBe(Sandbox.available())
        expect(await Bun.file(escaped).exists()).toBe(false)
        await LSP.dispose()
      },
    })
  } finally {
    process.env.PATH = original
    await Instance.disposeAll()
  }
})
