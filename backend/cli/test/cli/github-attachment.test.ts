import { describe, expect, test } from "bun:test"
import { GitHubAttachment } from "../../src/cli/github-attachment"

describe("GitHubAttachment", () => {
  test("accepts GitHub user attachment URLs", () => {
    const url = new URL(GitHubAttachment.parse("https://github.com/user-attachments/assets/abc-123?download=1"))

    expect(url.hostname).toBe("github.com")
    expect(url.pathname).toBe("/user-attachments/assets/abc-123")
    expect(url.search).toBe("")
  })

  test("accepts GitHub file attachment URLs", () => {
    const url = new URL(GitHubAttachment.parse("https://github.com/user-attachments/files/21433810/api%20schema.json"))

    expect(url.hostname).toBe("github.com")
    expect(url.pathname).toBe("/user-attachments/files/21433810/api%20schema.json")
  })

  test.each([
    "http://github.com/user-attachments/assets/abc",
    "https://github.com.evil.example/user-attachments/assets/abc",
    "https://evil.example/user-attachments/assets/abc",
    "https://github.com:444/user-attachments/assets/abc",
    "https://user@github.com/user-attachments/assets/abc",
    "https://github.com/repos/synthetic-sciences/openscience",
    "https://github.com/user-attachments/assets/abc/../../repos/private",
    "https://github.com/user-attachments/files/not-a-number/file.txt",
    "https://github.com/user-attachments/files/21433810/directory/file.txt",
  ])("rejects untrusted URL %s", (input) => {
    expect(() => GitHubAttachment.parse(input)).toThrow("Refusing to download non-GitHub attachment URL")
  })
})
