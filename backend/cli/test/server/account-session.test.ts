import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { AccountRoutes } from "../../src/server/routes/account"

const sessionFile = path.join(Global.Path.data, "openscience-session.json")

describe("account.session", () => {
  beforeEach(async () => {
    await fs.rm(sessionFile, { force: true })
  })

  afterEach(async () => {
    await fs.rm(sessionFile, { force: true })
  })

  test("reports signed out from local state", async () => {
    const response = await AccountRoutes().request("/session")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session: false })
  })

  test("reports signed in from local state without an Atlas round trip", async () => {
    await Bun.write(sessionFile, JSON.stringify({ api_key: "thk_test.fake", user_id: "test-user" }))

    const response = await AccountRoutes().request("/session")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ session: true })
  })
})
