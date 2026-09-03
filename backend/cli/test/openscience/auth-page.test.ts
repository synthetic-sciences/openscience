import { afterEach, expect, test } from "bun:test"
import { OpenScience } from "../../src/openscience"

const prior = { base: process.env.OPENSCIENCE_API_BASE, auth: process.env.SYNSC_AUTH_URL }

function restore(key: "OPENSCIENCE_API_BASE" | "SYNSC_AUTH_URL", value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restore("OPENSCIENCE_API_BASE", prior.base)
  restore("SYNSC_AUTH_URL", prior.auth)
})

test("the verification page follows the managed base override at call time", () => {
  delete process.env.SYNSC_AUTH_URL
  process.env.OPENSCIENCE_API_BASE = "https://first.example/"
  expect(OpenScience.authPageUrl()).toBe("https://first.example/cli")
  process.env.OPENSCIENCE_API_BASE = "https://second.example"
  expect(OpenScience.authPageUrl()).toBe("https://second.example/cli")
  process.env.SYNSC_AUTH_URL = "https://auth.example/"
  expect(OpenScience.authPageUrl()).toBe("https://auth.example")
})
