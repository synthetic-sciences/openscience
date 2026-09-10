import { describe, expect, test } from "bun:test"
import { NetworkCommands } from "../../src/tool/network-commands"
import { Sandbox } from "../../src/sandbox/sandbox"

describe("network command detection", () => {
  test("recognizes pushes, fetches and uploads and names their destination", () => {
    expect(NetworkCommands.detect([["git", "push", "origin", "main"]])).toEqual({
      hosts: [],
      remotes: ["origin"],
      commands: ["git push origin main"],
    })
    expect(NetworkCommands.detect([["git", "-C", "repo", "push"]])?.remotes).toEqual(["origin"])
    expect(NetworkCommands.detect([["git", "clone", "https://github.com/acme/repo.git"]])?.hosts).toEqual([
      "github.com",
    ])
    expect(NetworkCommands.detect([["git", "push", "git@github.com:acme/repo.git", "main"]])?.hosts).toEqual([
      "github.com",
    ])
    expect(NetworkCommands.detect([["gh", "pr", "create"]])?.hosts).toEqual(["github.com"])
    expect(NetworkCommands.detect([["huggingface-cli", "upload", "acme/data", "."]])?.hosts).toEqual(["huggingface.co"])
    expect(NetworkCommands.detect([["hf", "upload", "acme/data"]])?.hosts).toEqual(["huggingface.co"])
    expect(NetworkCommands.detect([["HF_TOKEN=x", "hf", "whoami"]])?.hosts).toEqual(["huggingface.co"])
    expect(NetworkCommands.detect([["pip", "install", "numpy"]])?.hosts).toEqual(["pypi.org"])
    expect(NetworkCommands.detect([["uv", "pip", "install", "numpy"]])?.hosts).toEqual(["pypi.org"])
    expect(NetworkCommands.detect([["npm", "publish"]])?.hosts).toEqual(["registry.npmjs.org"])
    expect(NetworkCommands.detect([["twine", "upload", "dist/*"]])?.hosts).toEqual(["upload.pypi.org"])
    expect(NetworkCommands.detect([["curl", "-fsSL", "https://api.example.org/v1"]])?.hosts).toEqual([
      "api.example.org",
    ])
    expect(NetworkCommands.detect([["scp", "file", "me@lab.example.edu:/data"]])?.hosts).toEqual(["lab.example.edu"])
  })

  test("leaves local work alone", () => {
    expect(NetworkCommands.detect([["git", "status"]])).toBeUndefined()
    expect(NetworkCommands.detect([["git", "commit", "-m", "push the button"]])).toBeUndefined()
    expect(NetworkCommands.detect([["git", "remote", "-v"]])).toBeUndefined()
    expect(NetworkCommands.detect([["npm", "test"]])).toBeUndefined()
    expect(NetworkCommands.detect([["pip", "list"]])).toBeUndefined()
    expect(
      NetworkCommands.detect([
        ["ls", "-la"],
        ["cat", "README.md"],
      ]),
    ).toBeUndefined()
    expect(NetworkCommands.detect([["docker", "build", "."]])).toBeUndefined()
  })

  test("merges several networked commands in one script", () => {
    const detected = NetworkCommands.detect([
      ["git", "push", "origin", "main"],
      ["gh", "release", "create", "v1"],
      ["curl", "https://huggingface.co/api"],
    ])
    expect(detected?.hosts).toEqual(["github.com", "huggingface.co"])
    expect(detected?.remotes).toEqual(["origin"])
    expect(detected?.commands).toHaveLength(3)
  })
})

describe("approved network escalation", () => {
  test("the seatbelt profile allows sockets only for an approved command, files stay confined", () => {
    const base = { writable: ["/w"], readable: ["/w"], readOnly: [], unreadable: ["/Users/me/.ssh"] }
    expect(Sandbox.seatbeltProfile({ ...base, network: false })).not.toContain("(allow network*)")
    expect(Sandbox.seatbeltProfile({ ...base, network: true })).not.toContain("(allow network*)")
    const escalated = Sandbox.seatbeltProfile({ ...base, network: true, escalatedNetwork: true })
    expect(escalated).toContain("(allow network*)")
    expect(escalated).toContain('(deny file-read* (literal "/Users/me/.ssh"))')
    expect(escalated).toContain('(allow file-write* (subpath "/w"))')
  })

  test("bubblewrap keeps the host network only for an approved command", () => {
    const base = { writable: ["/w"], readable: ["/w"], readOnly: [], unreadable: [] }
    expect(Sandbox.bubblewrapArgs({ ...base, network: true })).toContain("--unshare-net")
    expect(Sandbox.bubblewrapArgs({ ...base, network: true, escalatedNetwork: true })).not.toContain("--unshare-net")
  })
})
