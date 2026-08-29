import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Command } from "../../src/command"
import { Instance } from "../../src/project/instance"
import { ProjectTrust } from "../../src/project/trust"
import { PermissionNext } from "../../src/permission/next"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"

async function commandFile(directory: string, shell: string) {
  const root = path.join(directory, ".openscience", "command")
  await fs.mkdir(root, { recursive: true })
  await Bun.write(
    path.join(root, "review.md"),
    [`---`, `description: Project review`, `---`, `!\`${shell}\``].join("\n"),
  )
}

test("an untrusted project command cannot shadow a built-in or run shell interpolation", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      const marker = path.join(directory, "untrusted-command-ran")
      await commandFile(directory, `printf imported > ${JSON.stringify(marker)}`)
      return marker
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await ProjectTrust.update(Instance.project, { trusted: false })
      const command = await Command.get("review")
      expect(command?.description).not.toBe("Project review")
      expect(await Bun.file(tmp.extra).exists()).toBe(false)
    },
  })
})

test("trusted command shell interpolation uses the governed shell boundary", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      const marker = path.join(directory, "trusted-command-ran")
      await commandFile(directory, `printf governed > ${JSON.stringify(marker)}`)
      return marker
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({
        permission: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      const execution = SessionPrompt.command({
        sessionID: session.id,
        command: "review",
        arguments: "",
        // The contract under test ends after interpolation. A missing model
        // makes the following provider phase fail immediately and locally.
        model: "missing-provider/missing-model",
      }).catch((error) => error)

      let approval: PermissionNext.Request | undefined
      for (let attempt = 0; attempt < 100 && !approval; attempt++) {
        approval = (await PermissionNext.list()).find(
          (item) => item.sessionID === session.id && item.permission === "bash",
        )
        if (!approval) await Bun.sleep(5)
      }
      expect(approval).toMatchObject({
        permission: "bash",
        metadata: { shell: { command: expect.stringContaining("printf governed") } },
      })
      await PermissionNext.reply({ requestID: approval!.id, reply: "once" })

      const failure = await execution
      expect(failure).toBeInstanceOf(Error)
      expect(await Bun.file(tmp.extra).exists()).toBe(true)
      expect(await Bun.file(tmp.extra).text()).toBe("governed")
    },
  })
}, 10_000)
