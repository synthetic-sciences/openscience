import { describe, expect, test } from "bun:test"
import { NativeDirectoryPickerUnavailable, openNativeDirectoryPicker } from "./native-picker"

describe("native directory picker", () => {
  test("returns all folders chosen by the host dialog", async () => {
    const requests: URL[] = []
    const request = async (input: string | URL | Request) => {
      requests.push(new URL(String(input)))
      return Response.json({ paths: ["/work/alpha", "/work/beta"] })
    }

    const folders = await openNativeDirectoryPicker(
      { title: "Add sources", multiple: true, serverUrl: "http://127.0.0.1:4096" },
      request,
    )

    expect(folders).toEqual(["/work/alpha", "/work/beta"])
    expect(requests[0]?.pathname).toBe("/api/resolve-folder/dialog")
    expect(requests[0]?.searchParams.get("title")).toBe("Add sources")
    expect(requests[0]?.searchParams.get("multiple")).toBe("true")
  })

  test("treats a cancelled host dialog as no selection", async () => {
    const request = async () => Response.json({ error: "cancelled" }, { status: 499 })

    expect(await openNativeDirectoryPicker({ serverUrl: "http://127.0.0.1:4096" }, request)).toBeNull()
  })

  test("reports unsupported hosts so callers can use their in-app fallback", async () => {
    const request = async () => Response.json({ unsupported: true, message: "unsupported" }, { status: 501 })

    expect(openNativeDirectoryPicker({ serverUrl: "http://127.0.0.1:4096" }, request)).rejects.toBeInstanceOf(
      NativeDirectoryPickerUnavailable,
    )
  })
})
