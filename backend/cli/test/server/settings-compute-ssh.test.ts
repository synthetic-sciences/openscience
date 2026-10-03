import { describe, expect, test } from "bun:test"
import path from "path"
import { ComputeSettings } from "../../src/server/routes/settings/compute"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const CONFIG = `Host bastion
  HostName bastion.example.org
  User jump
  Port 22

Host euwest
  HostName eu-west.example.org
  User jump
  Port 22

Host target
  HostName target.example.org
  ProxyJump bastion, euwest
`

describe("ComputeSettings.sshConfigHosts", () => {
  test("keeps every hop of a multi-hop ProxyJump", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "config"), CONFIG)
        return path.join(directory, "config")
      },
    })

    const hosts = await ComputeSettings.sshConfigHosts(tmp.extra)
    const target = hosts.find((host) => host.alias === "target")

    expect(target?.proxy_jump).toBe("jump@bastion.example.org:22,jump@eu-west.example.org:22")
  })

  test("keeps a single hop and skips an explicit none", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(
          path.join(directory, "config"),
          `Host bastion
  HostName bastion.example.org
  User jump
  Port 22

Host single
  HostName single.example.org
  ProxyJump bastion

Host disabled
  HostName disabled.example.org
  ProxyJump none
`,
        )
        return path.join(directory, "config")
      },
    })

    const hosts = await ComputeSettings.sshConfigHosts(tmp.extra)
    const find = (alias: string) => hosts.find((host) => host.alias === alias)?.proxy_jump

    expect(find("single")).toBe("jump@bastion.example.org:22")
    expect(find("disabled")).toBeUndefined()
  })
})