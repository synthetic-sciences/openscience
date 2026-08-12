// Keep preload first: this reproduces the real CLI's earliest import boundary.
import "../../src/openscience/preload-env"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"

const marker = process.argv[2]!
await Instance.provide({
  directory: process.cwd(),
  init: Plugin.init,
  fn: async () => {
    process.stdout.write(
      `${JSON.stringify({
        marker: await Bun.file(marker).exists(),
        inline: process.env.OPENSCIENCE_CONFIG_CONTENT ?? null,
        provider: process.env.OPENAI_API_KEY ?? null,
        askpass: process.env.GIT_ASKPASS ?? null,
      })}\n`,
    )
  },
})
await Instance.disposeAll()
