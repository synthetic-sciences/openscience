import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Bus } from "../../src/bus"
import { File } from "../../src/file"
import { Format } from "../../src/format"
import { LSP } from "../../src/lsp"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { tmpdir } from "../fixture/fixture"

test("built-in project formatter checks trust on every cached file edit", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const marker = path.join(dir, "formatted")
      const bin = path.join(dir, "vendor", "bin", "pint")
      const file = path.join(dir, "test.php")
      await fs.mkdir(path.dirname(bin), { recursive: true })
      await Bun.write(
        path.join(dir, "composer.json"),
        JSON.stringify({
          "require-dev": {
            "laravel/pint": "*",
          },
        }),
      )
      await Bun.write(bin, `#!/bin/sh\nprintf x >> ${JSON.stringify(marker)}\n`)
      await fs.chmod(bin, 0o755)
      await Bun.write(file, "<?php\n")
      return { file, marker }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      try {
        await ProjectTrust.update(Instance.project, { trusted: false })
        Format.init()
        await Bus.publish(File.Event.Edited, { file: tmp.extra.file })
        expect(await Bun.file(tmp.extra.marker).exists()).toBe(false)

        const status = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, {
          trusted: true,
          root: status.root,
        })
        await Bus.publish(File.Event.Edited, { file: tmp.extra.file })
        expect(await Bun.file(tmp.extra.marker).text()).toBe("x")

        await ProjectTrust.update(Instance.project, { trusted: false })
        await Bus.publish(File.Event.Edited, { file: tmp.extra.file })
        expect(await Bun.file(tmp.extra.marker).text()).toBe("x")
      } finally {
        await Instance.dispose()
      }
    },
  })
})

test("cached project formatter config cannot execute after trust revocation", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const marker = path.join(dir, "configured")
      const file = path.join(dir, "test.probe")
      const script = [
        `const file = Bun.file(${JSON.stringify(marker)})`,
        `await Bun.write(${JSON.stringify(marker)}, await file.text().catch(() => "") + "x")`,
      ].join(";")
      await Bun.write(
        path.join(dir, "openscience.json"),
        JSON.stringify({
          formatter: {
            probe: {
              command: [process.execPath, "-e", script],
              extensions: [".probe"],
            },
          },
        }),
      )
      await Bun.write(file, "test")
      return { file, marker }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      try {
        const status = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, {
          trusted: true,
          root: status.root,
        })
        Format.init()
        expect((await Format.status()).map((item) => item.name)).toContain("probe")

        await ProjectTrust.update(Instance.project, { trusted: false })
        await Bus.publish(File.Event.Edited, { file: tmp.extra.file })
        expect(await Bun.file(tmp.extra.marker).exists()).toBe(false)

        await ProjectTrust.update(Instance.project, {
          trusted: true,
          root: status.root,
        })
        await Bus.publish(File.Event.Edited, { file: tmp.extra.file })
        expect(await Bun.file(tmp.extra.marker).text()).toBe("x")

        await ProjectTrust.update(Instance.project, { trusted: false })
        await Bus.publish(File.Event.Edited, { file: tmp.extra.file })
        expect(await Bun.file(tmp.extra.marker).text()).toBe("x")
      } finally {
        await Instance.dispose()
      }
    },
  })
})

test("built-in project LSP denies, executes when trusted, and stops its cached client after revocation", async () => {
  await using tmp = await tmpdir({
    init: async (dir) => {
      const marker = path.join(dir, "lsp-started")
      const bin = path.join(dir, "node_modules", ".bin", "biome")
      const file = path.join(dir, "test.jsonc")
      const server = path.join(dir, "fake-lsp-server.js")
      await fs.mkdir(path.dirname(bin), { recursive: true })
      await fs.copyFile(path.join(import.meta.dir, "../fixture/lsp/fake-lsp-server.js"), server)
      await Bun.write(path.join(dir, "biome.json"), "{}")
      await Bun.write(
        bin,
        [
          "#!/bin/sh",
          `printf x >> ${JSON.stringify(marker)}`,
          `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)}`,
          "",
        ].join("\n"),
      )
      await fs.chmod(bin, 0o755)
      await Bun.write(file, "{}")
      return { file, marker }
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      try {
        await ProjectTrust.update(Instance.project, { trusted: false })
        await LSP.init()
        await LSP.touchFile(tmp.extra.file)
        expect(await Bun.file(tmp.extra.marker).exists()).toBe(false)
        expect(await LSP.status()).toEqual([])

        const status = await ProjectTrust.status(Instance.project)
        await ProjectTrust.update(Instance.project, {
          trusted: true,
          root: status.root,
        })
        await LSP.touchFile(tmp.extra.file)
        expect(await Bun.file(tmp.extra.marker).text()).toBe("x")
        expect((await LSP.status()).map((item) => item.name)).toEqual(["biome"])

        await ProjectTrust.update(Instance.project, { trusted: false })
        await LSP.touchFile(tmp.extra.file)
        expect(await Bun.file(tmp.extra.marker).text()).toBe("x")
        expect(await LSP.status()).toEqual([])
      } finally {
        await Instance.dispose()
      }
    },
  })
})
