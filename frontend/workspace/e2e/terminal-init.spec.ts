import { test, expect } from "./fixtures"
import { terminalSelector } from "./utils"

test.describe.configure({ mode: "serial" })

test("terminal executes output and can switch and close another tab", async ({ page, gotoSession, sdk }) => {
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
    await gotoSession()

    const terminalTab = page.getByRole("tab", { name: "terminal", exact: true })
    await terminalTab.click()
    await expect(terminalTab).toHaveAttribute("aria-selected", "true")

    const terminals = page.locator(terminalSelector)
    if ((await terminals.count()) === 0) {
      await page.getByRole("button", { name: "start terminal", exact: true }).click()
    }

    await expect(terminals.first()).toBeVisible()
    const input = terminals.first().locator("textarea")
    await expect(input).toHaveCount(1)
    await expect.poll(() => output.length, { timeout: 15_000 }).toBeGreaterThan(0)

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

    await page.getByRole("button", { name: "new", exact: true }).click()
    await expect(terminals).toHaveCount(before + 1)
    await expect(terminals.nth(before).locator("textarea")).toHaveCount(1)

    await expect
      .poll(async () => ((await sdk.pty.list()).data ?? []).filter((pty) => !initial.has(pty.id)))
      .toHaveLength(2)
    const secondPty = ((await sdk.pty.list()).data ?? []).find((pty) => !initial.has(pty.id) && pty.id !== firstPty.id)
    if (!secondPty) throw new Error("Second test terminal was not created")

    const firstTerminal = page.locator(`#terminal-wrapper-${firstPty.id} ${terminalSelector}`)
    const secondTerminal = page.locator(`#terminal-wrapper-${secondPty.id} ${terminalSelector}`)
    const firstTab = page.getByText(firstPty.title, { exact: true }).locator("..")
    const secondTab = page.getByText(secondPty.title, { exact: true }).locator("..")

    await expect(firstTerminal).toBeHidden()
    await expect(secondTerminal).toBeVisible()

    await firstTab.click()
    await expect(firstTerminal).toBeVisible()
    await expect(secondTerminal).toBeHidden()

    await secondTab.click()
    await expect(secondTerminal).toBeVisible()
    await secondTab.locator("span").last().click()

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

test("terminal panel can be collapsed and reopened", async ({ page, gotoSession }) => {
  await gotoSession()

  const terminalTab = page.getByRole("tab", { name: "terminal", exact: true })
  await expect(terminalTab).toBeVisible()
  await terminalTab.click()
  await expect(terminalTab).toHaveAttribute("aria-selected", "true")

  await page.getByTitle("hide panel", { exact: true }).click()
  await expect(terminalTab).toHaveCount(0)

  await page.getByRole("button", { name: "terminal", exact: true }).click()
  await expect(terminalTab).toBeVisible()
  await expect(terminalTab).toHaveAttribute("aria-selected", "true")
})
