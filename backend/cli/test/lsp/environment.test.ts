import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { Sandbox } from "../../src/sandbox/sandbox"
import { tmpdir } from "../fixture/fixture"

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

test("language-server children never inherit host credentials", async () => {
  await using tmp = await tmpdir()
  const bin = path.join(tmp.path, "host-bin")
  const project = path.join(tmp.path, "project")
  const marker = path.join(project, "lsp-environment")
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
    `#!/bin/sh\nprintf '%s|%s|%s' "\${AWS_SECRET_ACCESS_KEY:-absent}" "\${OPENAI_API_KEY:-absent}" "\${LAB_ACCESS_TOKEN:-absent}" > ${quote(marker)}\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
  )
  await fs.chmod(server, 0o700)

  const saved = {
    PATH: process.env.PATH,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    LAB_ACCESS_TOKEN: process.env.LAB_ACCESS_TOKEN,
  }
  process.env.PATH = `${bin}${path.delimiter}${saved.PATH ?? ""}`
  process.env.AWS_SECRET_ACCESS_KEY = "aws-host-secret"
  process.env.OPENAI_API_KEY = "provider-host-secret"
  process.env.LAB_ACCESS_TOKEN = "settings-host-secret"
  try {
    await Instance.provide({
      directory: project,
      fn: async () => {
        const status = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, { trusted: true, root: status.root })
        await LSP.touchFile(source)
        for (let attempt = 0; attempt < 50 && !(await Bun.file(marker).exists()); attempt++) await Bun.sleep(10)
        if (Sandbox.available()) expect(await Bun.file(marker).text()).toBe("absent|absent|absent")
        else expect(await Bun.file(marker).exists()).toBe(false)
        await LSP.dispose()
      },
    })
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await Instance.disposeAll()
  }
})
