import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("session.list", () => {
  test("filters by directory", async () => {
    await using other = await tmpdir()
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const first = await Session.create({})

        const second = await Instance.provide({
          directory: other.path,
          fn: async () => Session.create({}),
        })

        const fetch = Server.internalFetch()
        const response = await fetch(`http://openscience.internal/session?directory=${encodeURIComponent(projectRoot)}`)
        expect(response.status).toBe(200)

        const body = (await response.json()) as unknown[]
        const ids = body
          .map((s) => (typeof s === "object" && s && "id" in s ? (s as { id: string }).id : undefined))
          .filter((x): x is string => typeof x === "string")

        expect(ids).toContain(first.id)
        expect(ids).not.toContain(second.id)
      },
    })
  })

  test("applies the limit before appending a match", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        await Session.create({})
        await Session.create({})
        const fetch = Server.internalFetch()

        const empty = await fetch(`http://openscience.internal/session?limit=0`)
        expect(empty.status).toBe(200)
        expect(await empty.json()).toEqual([])

        const single = await fetch(`http://openscience.internal/session?limit=1`)
        expect(single.status).toBe(200)
        expect(((await single.json()) as unknown[]).length).toBe(1)
      },
    })
  })
})
