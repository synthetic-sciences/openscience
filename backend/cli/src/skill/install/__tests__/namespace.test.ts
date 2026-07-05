import { describe, it, expect } from "bun:test"
import { parseSkillUrl } from "../namespace"

describe("parseSkillUrl", () => {
  it("parses full GitHub URL with default branch", () => {
    expect(parseSkillUrl("https://github.com/anthropics/superpowers")).toEqual({
      kind: "git",
      host: "github.com",
      owner: "anthropics",
      repo: "superpowers",
      ref: null,
      path: null,
      namespace: "superpowers",
      cloneUrl: "https://github.com/anthropics/superpowers.git",
    })
  })

  it("parses GitHub URL with /tree/<ref>", () => {
    expect(parseSkillUrl("https://github.com/anthropics/superpowers/tree/v5.1.0")).toMatchObject({
      ref: "v5.1.0",
      namespace: "superpowers",
    })
  })

  it("parses gh: shorthand without ref", () => {
    expect(parseSkillUrl("gh:anthropics/superpowers")).toMatchObject({
      owner: "anthropics",
      repo: "superpowers",
      ref: null,
      namespace: "superpowers",
    })
  })

  it("parses gh: shorthand with ref + path", () => {
    expect(parseSkillUrl("gh:anthropics/superpowers@v5.1.0/skills/brainstorming")).toMatchObject({
      ref: "v5.1.0",
      path: "skills/brainstorming",
      namespace: "superpowers",
    })
  })

  it("strips trailing slashes", () => {
    expect(parseSkillUrl("https://github.com/anthropics/superpowers/")).toMatchObject({ repo: "superpowers" })
  })

  it("normalizes namespace (lowercase, hyphens preserved)", () => {
    expect(parseSkillUrl("gh:Foo/Bar-Baz")).toMatchObject({
      owner: "Foo",
      repo: "Bar-Baz",
      namespace: "bar-baz",
    })
  })

  it("strips .git suffix from GitHub URLs", () => {
    expect(parseSkillUrl("https://github.com/obra/superpowers.git")).toMatchObject({
      owner: "obra",
      repo: "superpowers",
      namespace: "superpowers",
      cloneUrl: "https://github.com/obra/superpowers.git",
    })
  })

  it("strips .git suffix from gh: shorthand", () => {
    expect(parseSkillUrl("gh:obra/superpowers.git")).toMatchObject({
      owner: "obra",
      repo: "superpowers",
      namespace: "superpowers",
      cloneUrl: "https://github.com/obra/superpowers.git",
    })
  })

  it("rejects non-URLs", () => {
    expect(() => parseSkillUrl("not-a-url")).toThrow()
  })
})
