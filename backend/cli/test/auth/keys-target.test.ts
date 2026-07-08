import { test, expect, describe } from "bun:test"
import { classifyKeyTarget } from "../../src/cli/cmd/auth"

// #142: `openscience keys add deepseek` used the bare provider name as a URL and
// crashed with "fetch() URL is invalid". classifyKeyTarget separates a real
// custom-endpoint URL from a provider id to preselect.

describe("classifyKeyTarget", () => {
  test("a bare provider name preselects, never becomes a URL fetch", () => {
    expect(classifyKeyTarget("deepseek")).toEqual({ preselect: "deepseek" })
    expect(classifyKeyTarget("openrouter")).toEqual({ preselect: "openrouter" })
  })

  test("strips an @ai-sdk/ prefix when preselecting", () => {
    expect(classifyKeyTarget("@ai-sdk/openai")).toEqual({ preselect: "openai" })
  })

  test("an http(s) URL is a custom endpoint, not a provider", () => {
    expect(classifyKeyTarget("https://api.example.com/v1")).toEqual({ endpointUrl: "https://api.example.com/v1" })
    expect(classifyKeyTarget("http://localhost:8080")).toEqual({ endpointUrl: "http://localhost:8080" })
  })

  test("no positional yields neither (interactive picker)", () => {
    expect(classifyKeyTarget(undefined)).toEqual({})
    expect(classifyKeyTarget("")).toEqual({})
  })

  test("a malformed positional (slash, spaces, caps) is neither — no crash path", () => {
    // The exact shape from the issue: a full model ref, not a provider id.
    expect(classifyKeyTarget("deepseek/deepseek-v4-pro")).toEqual({})
    expect(classifyKeyTarget("Some Provider")).toEqual({})
    expect(classifyKeyTarget("ftp://x")).toEqual({})
  })
})
