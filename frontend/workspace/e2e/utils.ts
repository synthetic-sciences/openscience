import { expect, type Page } from "@playwright/test"
import { createOpenScienceClient } from "@synsci/sdk/v2/client"
import { base64Encode } from "@synsci/util/encode"

const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "localhost"
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"

export const serverUrl = `http://${serverHost}:${serverPort}`
export const serverName = `${serverHost}:${serverPort}`

export const promptSelector = '[data-component="prompt-input"]'
export const terminalSelector = '[data-component="terminal"]'
export const modelTriggerSelector = "[data-model-settings-trigger]"
export const modelPopoverSelector = "[data-model-settings-popover]"

export function createSdk(directory?: string) {
  return createOpenScienceClient({ baseUrl: serverUrl, directory, throwOnError: true })
}

/** Explicitly trusts a test project before exercising process execution. */
export async function trustProject(sdk: ReturnType<typeof createSdk>, directory: string) {
  const project = await sdk.project.current().then((result) => result.data)
  if (!project?.id) throw new Error(`Failed to resolve the project for ${directory}`)
  const status = await sdk.project.trust.get({ projectID: project.id, directory }).then((result) => result.data)
  if (!status?.root) throw new Error(`Failed to resolve the canonical project root for ${directory}`)
  if (status.canExecuteProjectCode) return
  const trusted = await sdk.project.trust
    .update({ projectID: project.id, directory, body: { trusted: true, root: status.root } })
    .then((result) => result.data)
  if (!trusted?.canExecuteProjectCode) throw new Error(`Failed to trust the test project at ${directory}`)
}

/** Opens the primary settings dialog through the compact project rail. */
export async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Customize OpenScience", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  return dialog
}

export async function getWorktree() {
  const sdk = createSdk()
  const result = await sdk.path.get()
  const data = result.data
  if (!data?.worktree) throw new Error(`Failed to resolve a worktree from ${serverUrl}/path`)
  return data.worktree
}

function dirSlug(directory: string) {
  return base64Encode(directory)
}

export function dirPath(directory: string) {
  return `/${dirSlug(directory)}`
}

const prefix = (value: string) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`)

/**
 * Picks a connected folder by name and asserts the pane actually switched to
 * it. Up to three connected folders can be promoted to primary tabs
 * (`[data-workspace-source="connected"]`) beside Project files; any beyond
 * that stay in the overflow menu behind `[data-source-button]`. While a
 * primary tab is active that trigger's own label reads "More" (SourceMenu's
 * `triggerLabel`), so the trigger's text cannot say which source is current
 * either way. Prefer the tab when this folder has one, otherwise use the
 * menu, then confirm the switch through what the browser itself renders for
 * the current source rather than the trigger.
 */
async function pickSource(page: Page, name: string) {
  const files = page.getByRole("region", { name: "Files", exact: true })
  const tab = files.locator('[data-workspace-source="connected"]').filter({ hasText: prefix(name) })
  if (await tab.isVisible().catch(() => false)) {
    await tab.click()
    await expect(tab).toHaveAttribute("aria-selected", "true")
  } else {
    const picker = files.locator("[data-source-button]")
    if ((await picker.getAttribute("aria-expanded")) !== "true") await picker.click()
    await page.getByRole("menuitemradio", { name: prefix(name) }).click()
  }
  const browser = files.locator("[data-files-browser]")
  await expect(browser).toHaveAttribute("data-source-kind", "connected")
  await expect(browser.locator("[data-refresh-source]")).toHaveAttribute("aria-label", `Refresh ${name}`)
}

/** Opens the Files browser and selects the project's working-files source. */
export async function openFilesSources(page: Page) {
  const files = page.getByRole("region", { name: "Files", exact: true })
  if (!(await files.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open project files", exact: true }).click()
    await expect(files).toBeVisible()
  }
  const project = files.locator('[data-workspace-source="project"]')
  await expect(project).toBeVisible()
  if ((await project.getAttribute("aria-selected")) !== "true") await project.click()
  await expect(project).toHaveAttribute("aria-selected", "true")
  await expect(files.locator("[data-files-browser]")).toHaveAttribute("data-source-kind", "project")
  const root = files.locator("[data-path-root]")
  if (await root.isVisible().catch(() => false)) await root.click()
}

export async function openFileRow(page: Page, name: string) {
  const files = page.getByRole("region", { name: "Files", exact: true })
  await files.getByRole("searchbox").fill(name)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  await files.getByRole("button", { name: new RegExp(`^Open (?:file|folder) ${escaped}$`) }).click()
}

export function fileTab(page: Page, title: string) {
  return page.getByRole("tablist", { name: "Contextual work tabs", exact: true }).getByRole("tab", {
    name: title,
    exact: true,
  })
}

/** The visible active-session title now lives in the chat header tab strip. */
export function sessionHeading(page: Page, title: string) {
  const exact = new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)
  return page.locator(".workspace-tabs [data-session-tab]").filter({ hasText: exact })
}

/**
 * Opens a project file through the project's working-files source. `relativePath` is
 * relative to the project root; folders are descended one at a time exactly
 * like a user would. Returns the file tab, asserted active.
 */
export async function openWorkspaceFile(page: Page, relativePath: string) {
  await openFilesSources(page)
  const segments = relativePath.split("/")
  const filename = segments.pop()
  if (!filename) throw new Error(`Cannot open a folder as a file: ${relativePath}`)
  for (const segment of segments) {
    await openFileRow(page, segment)
  }
  await openFileRow(page, filename)
  const tab = fileTab(page, filename)
  await expect(tab).toHaveAttribute("aria-selected", "true")
  return tab
}

/**
 * Opens a file from an already granted outside folder through the
 * "Connected folders" source list. `folder` must match the grant path.
 */
export async function openConnectedFile(page: Page, folder: string, filename: string) {
  await openFilesSources(page)
  const name = folder.split("/").filter(Boolean).pop() ?? folder
  await pickSource(page, name)
  await openFileRow(page, filename)
  const tab = fileTab(page, filename)
  await expect(tab).toHaveAttribute("aria-selected", "true")
  return tab
}

async function openModelOptions(page: Page) {
  const trigger = page.locator("[data-model-effort-chip]")
  const popover = page.locator('[data-model-settings-popover][data-model-popover-kind="effort"]')
  if (!(await popover.isVisible().catch(() => false))) await trigger.click()
  await expect(popover).toBeVisible()
  return popover
}

/** Sets reasoning effort through the dedicated model-options popover. */
export async function setModelEffort(page: Page, id: string) {
  const popover = await openModelOptions(page)
  const option = popover.locator(`[data-model-option="effort"][data-model-option-id="${id}"]`)
  await option.click()
  // The click re-renders the option list; Escape typed before focus settles
  // inside the popover is swallowed. Wait for the selection to land, then
  // dismiss from within the popover itself.
  await expect(option).toHaveAttribute("aria-checked", "true")
  await popover.press("Escape")
  await expect(popover).toBeHidden()
}

/** Sets inference speed through the same model-options popover. */
export async function setModelSpeed(page: Page, id: string) {
  const popover = await openModelOptions(page)
  const input = popover.getByRole("switch", { name: /Fast mode/ })
  const target = id === "fast"
  if ((await input.isChecked()) !== target) {
    await popover.locator('[data-model-fast-toggle] [data-slot="switch-control"]').click()
    await expect(input).toBeChecked({ checked: target })
  }
  await page.keyboard.press("Escape")
  await expect(popover).toBeHidden()
}

/** Reads the current effort or speed from the compact model-options trigger. */
export async function modelRowValue(page: Page, kind: "effort" | "speed") {
  const trigger = page.locator("[data-model-effort-chip]")
  if (kind === "effort") return (await trigger.locator("strong").innerText()).trim()
  return (await trigger.getAttribute("aria-label"))?.includes("Fast mode on") ? "Fast" : "Standard"
}
