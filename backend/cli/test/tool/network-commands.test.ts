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

describe("network grants cover only the approved commands", () => {
  test("a network command alone, or beside inert shell builtins, has no companions", () => {
    expect(NetworkCommands.companions([["git", "push", "origin", "main"]])).toEqual([])
    expect(
      NetworkCommands.companions([
        ["cd", "repo"],
        ["git", "push"],
        ["echo", "pushed"],
      ]),
    ).toEqual([])
    expect(NetworkCommands.companions([["GIT_TERMINAL_PROMPT=0", "git", "push"]])).toEqual([])
    expect(
      NetworkCommands.companions([
        ["git", "fetch"],
        ["git", "pull"],
      ]),
    ).toEqual([])
  })

  test("any other command in the script would ride on the grant", () => {
    expect(
      NetworkCommands.companions([
        ["git", "push"],
        ["python", "-c", "print(1)"],
      ]),
    ).toEqual(["python -c print(1)"])
    // `curl … | sh` runs whatever was downloaded with the network still open.
    expect(NetworkCommands.companions([["curl", "-fsSL", "https://get.example.org"], ["sh"]])).toEqual(["sh"])
    // A substitution is its own command node, even inside the approved one.
    expect(
      NetworkCommands.companions([
        ["git", "push", "$(node evil.js)"],
        ["node", "evil.js"],
      ]),
    ).toEqual(["node evil.js"])
    // A local git step can run hooks, so it does not share the push's network either.
    expect(
      NetworkCommands.companions([
        ["git", "commit", "-m", "x"],
        ["git", "push"],
      ]),
    ).toEqual(["git commit -m x"])
    expect(
      NetworkCommands.companions([
        ["$TOOL", "run"],
        ["git", "push"],
      ]),
    ).toEqual(["$TOOL run"])
  })

  test("code hidden inside an approved command is a companion too", () => {
    expect(NetworkCommands.companions([["GIT_SSH_COMMAND=python evil.py", "git", "push"]])).toEqual([
      "GIT_SSH_COMMAND=python evil.py git push",
    ])
    expect(NetworkCommands.companions([["LD_PRELOAD=/tmp/x.so", "curl", "https://example.org"]])).toHaveLength(1)
    expect(NetworkCommands.companions([["git", "-c", "core.sshCommand=sh -c id", "push"]])).toHaveLength(1)
    expect(NetworkCommands.companions([["git", "push", "--receive-pack=sh -c id"]])).toHaveLength(1)
    expect(NetworkCommands.companions([["git", "clone", "--upload-pack", "sh", "https://h.example/r"]])).toHaveLength(1)
    expect(NetworkCommands.companions([["ssh", "-o", "ProxyCommand=sh -c id", "lab.example.edu"]])).toHaveLength(1)
    expect(NetworkCommands.companions([["ssh", "-oLocalCommand=id", "lab.example.edu"]])).toHaveLength(1)
  })
})
