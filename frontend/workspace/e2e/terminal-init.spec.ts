import { test, expect } from "./fixtures"
import { createSdk, terminalSelector, trustProject } from "./utils"

test.describe.configure({ mode: "serial" })

test("terminal executes output and can switch and close another tab", async ({ page, openSession, sdk, directory }) => {
  const initial = new Set((await sdk.pty.list()).data?.map((pty) => pty.id) ?? [])
  const marker = "OPENSCIENCE_TERMINAL_E2E_4242"
  let output = ""

  page.on("websocket", (socket) => {
    if (!/\/pty\/[^/]+\/connect(?:\?|$)/.test(socket.url())) return
    socket.on("framereceived", ({ payload }) => {
      output += typeof payload === "string" ? payload : payload.toString("utf8")
    })
  })

  try {
    await openSession()
    await trustProject(createSdk(directory), directory)

    await page.getByRole("button", { name: "Open project terminal", exact: true }).click()
    const surface = page.getByRole("region", { name: "Session terminal" })
    await expect(surface).toBeVisible()

    const terminals = page.locator(terminalSelector)
    await expect(terminals.first()).toBeVisible({ timeout: 15_000 })
    const input = terminals.first().locator("textarea")
    await expect(input).toHaveCount(1)
    await expect.poll(() => output.length, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(output).not.toContain("Restored session")
    expect(output).not.toContain("locking failed")

    await input.focus()
    // The exact marker does not occur in the command itself, so matching it in
    // a server-to-browser PTY frame proves the shell produced the output rather
    // than merely echoing our input.
    await page.keyboard.type("printf 'OPENSCIENCE_TERMINAL_E2E_%s\\n' 4242")
    await page.keyboard.press("Enter")
    await expect.poll(() => output, { timeout: 15_000 }).toContain(marker)

    await expect
      .poll(async () => ((await sdk.pty.list()).data ?? []).filter((pty) => !initial.has(pty.id)))
      .toHaveLength(1)
    const firstPty = ((await sdk.pty.list()).data ?? []).find((pty) => !initial.has(pty.id))
    if (!firstPty) throw new Error("First test terminal was not created")

    const before = await terminals.count()

    await page.getByRole("button", { name: "New terminal", exact: true }).click()
    await expect(terminals).toHaveCount(before + 1)
    await expect(terminals.nth(before).locator("textarea")).toHaveCount(1)

    await expect
      .poll(async () => ((await sdk.pty.list()).data ?? []).filter((pty) => !initial.has(pty.id)))
      .toHaveLength(2)
    const secondPty = ((await sdk.pty.list()).data ?? []).find((pty) => !initial.has(pty.id) && pty.id !== firstPty.id)
    if (!secondPty) throw new Error("Second test terminal was not created")

    const firstTerminal = page.locator(`#terminal-wrapper-${firstPty.id} ${terminalSelector}`)
    const secondTerminal = page.locator(`#terminal-wrapper-${secondPty.id} ${terminalSelector}`)
    // Terminal tabs carry aria-controls pointing at their panel, which is a
    // stable identity even when two shells share a title.
    const tab = (id: string) => surface.locator(`[role="tab"][aria-controls="terminal-wrapper-${id}"]`)
    const closeTab = (id: string) =>
      surface
        .locator(".terminal-surface__tab-shell")
        .filter({ has: page.locator(`[aria-controls="terminal-wrapper-${id}"]`) })
        .locator(".terminal-surface__close")

    await expect(firstTerminal).toBeHidden()
    await expect(secondTerminal).toBeVisible()

    await tab(firstPty.id).click()
    await expect(firstTerminal).toBeVisible()
    await expect(secondTerminal).toBeHidden()

    await tab(secondPty.id).click()
    await expect(secondTerminal).toBeVisible()
    await closeTab(secondPty.id).click()

    await expect(terminals).toHaveCount(before)
    await expect(firstTerminal).toBeVisible()
    await expect
      .poll(async () => ((await sdk.pty.list()).data ?? []).some((pty) => pty.id === secondPty.id))
      .toBe(false)
  } finally {
    const created = ((await sdk.pty.list()).data ?? []).filter((pty) => !initial.has(pty.id))
    await Promise.all(created.map((pty) => sdk.pty.remove({ ptyID: pty.id }).catch(() => undefined)))
  }
})

test("terminal panel can be collapsed and reopened", async ({ page, openSession }) => {
  await openSession()

  const open = page.getByRole("button", { name: "Open project terminal", exact: true })
  await open.click()
  const surface = page.getByRole("region", { name: "Session terminal" })
  await expect(surface).toBeVisible()

  await page.getByRole("button", { name: "Close context", exact: true }).click()
  await expect(surface).toHaveCount(0)

  await open.click()
  await expect(surface).toBeVisible()
})
