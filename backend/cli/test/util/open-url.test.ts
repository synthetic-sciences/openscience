import { expect, test } from "bun:test"
import { launchers } from "../../src/util/open-url"

// A sign-in approval page carries query arguments. Explorer opens a File
// Explorer window for such a URL instead of the browser (#699), so Windows
// must hand it to ShellExecute through url.dll first, by absolute path.
const url = "https://app.example.com/cli/approve?state=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A5123%2Fcallback"

test("windows hands the URL to url.dll first and keeps explorer as the fallback", () => {
  const plan = launchers(url, { platform: "win32", env: { SystemRoot: "D:\\Win" } })
  expect(plan.map((item) => item.file)).toEqual(["D:\\Win\\System32\\rundll32.exe", "D:\\Win\\explorer.exe"])
  expect(plan[0]!.args).toEqual(["url.dll,FileProtocolHandler", url])
  expect(plan[1]!.args).toEqual([url])
  // rundll32 reports a failure through its status; explorer exits 1 even when it opened the link.
  expect(plan[0]!.launched(0)).toBe(true)
  expect(plan[0]!.launched(1)).toBe(false)
  expect(plan[1]!.launched(1)).toBe(true)
})

test("windows falls back to the default system root when the environment does not name one", () => {
  const plan = launchers(url, { platform: "win32", env: {} })
  expect(plan[0]!.file).toBe("C:\\Windows\\System32\\rundll32.exe")
  expect(plan[1]!.file).toBe("C:\\Windows\\explorer.exe")
  expect(launchers(url, { platform: "win32", env: { windir: "E:\\Windows" } })[0]!.file).toBe(
    "E:\\Windows\\System32\\rundll32.exe",
  )
})

test("macOS and Linux keep their single opener", () => {
  expect(launchers(url, { platform: "darwin", env: {} })).toMatchObject([{ file: "open", args: [url] }])
  expect(launchers(url, { platform: "linux", env: {} })).toMatchObject([{ file: "xdg-open", args: [url] }])
  expect(launchers(url, { platform: "linux", env: {} })[0]!.launched(0)).toBe(true)
  expect(launchers(url, { platform: "linux", env: {} })[0]!.launched(3)).toBe(false)
})
