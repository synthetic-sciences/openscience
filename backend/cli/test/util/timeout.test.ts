import { describe, expect, test } from "bun:test"
import { withTimeout } from "../../src/util/timeout"

describe("util.timeout", () => {
  test("should resolve when promise completes before timeout", async () => {
    const fastPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("fast"), 10)
    })

    const result = await withTimeout(fastPromise, 100)
    expect(result).toBe("fast")
  })

  test("should reject when promise exceeds timeout", async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("slow"), 200)
    })

    await expect(withTimeout(slowPromise, 50)).rejects.toThrow("Operation timed out after 50ms")
  })

  test("should clear the timer when the promise rejects", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        import { withTimeout } from "../../src/util/timeout"
        const reason = new Error("upstream died")
        await withTimeout(Promise.reject(reason), 60_000).catch((error) => {
          if (error !== reason) throw error
          console.log("settled")
        })
      `,
      ],
      { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", timeout: 5_000 },
    )
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("settled\n")
    expect(await new Response(child.stderr).text()).toBe("")
  })
})
