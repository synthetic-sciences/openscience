import { expect, type Page } from "@playwright/test"
import { createOpenScienceClient } from "@synsci/sdk/v2/client"
import { base64Encode } from "@synsci/util/encode"

export const serverHost = process.env.PLAYWRIGHT_SERVER_HOST ?? "localhost"
export const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"

export const serverUrl = `http://${serverHost}:${serverPort}`
export const serverName = `${serverHost}:${serverPort}`

export const modKey = process.platform === "darwin" ? "Meta" : "Control"
export const terminalToggleKey = "Control+Backquote"

export const promptSelector = '[data-component="prompt-input"]'
export const terminalSelector = '[data-component="terminal"]'
export const modelTriggerSelector = "[data-model-settings-trigger]"
export const modelPopoverSelector = "[data-model-settings-popover]"
export const effortChipSelector = "[data-model-effort-chip]"

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

export function dirSlug(directory: string) {
  return base64Encode(directory)
}

export function dirPath(directory: string) {
  return `/${dirSlug(directory)}`
}

export function sessionPath(directory: string, sessionID?: string) {
  return `${dirPath(directory)}/session${sessionID ? `/${sessionID}` : ""}`
}

const prefix = (value: string) => new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`)

async function pickSource(page: Page, name: string) {
  const picker = page.locator("[data-source-button]")
  const label = picker.locator(".files-source__name")
  if ((await picker.getAttribute("aria-expanded")) !== "true") await picker.click()
  await page.getByRole("menuitemradio", { name: prefix(name) }).click()
  await expect(label).toHaveText(name)
}

/** Opens the Files browser and selects the session filesystem source. */
export async function openFilesSources(page: Page) {
  const files = page.getByRole("region", { name: "Files", exact: true })
  if (!(await files.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open project files", exact: true }).click()
    await expect(files).toBeVisible()
  }
  const browser = files.getByRole("tab", { name: "Files", exact: true })
  if ((await browser.getAttribute("aria-selected")) !== "true") await browser.click()
  await pickSource(page, "Session files")
}

export async function openFileRow(page: Page, name: string) {
  const files = page.getByRole("region", { name: "Files", exact: true })
  await files.getByRole("searchbox", { name: prefix("Search") }).fill(name)
  await files.getByRole("button", { name: prefix(name) }).click()
}

export function fileTab(page: Page, title: string) {
  return page.locator(`.files-tabs [role="tab"][title="${title}"]`)
}

/**
 * A session tab in the workspace tab strip, matched by its title text. The
 * tab's accessible name also folds in its close button ("Close <title> tab"),
 * so match on visible text rather than the computed role name.
 */
export function sessionTab(page: Page, title: string) {
  return page.locator('.workspace-tabs [role="tab"]').filter({ hasText: title })
}

/**
 * Opens a project file through the session-files source. `relativePath` is
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

/**
 * Opens the composer model-settings popover. Effort and speed live here as
 * menu rows ("Effort"/"Speed"), each expanding to a radio list of options.
 */
export async function openModelSettings(page: Page) {
  const popover = page.locator(modelPopoverSelector)
  if (!(await popover.isVisible().catch(() => false))) await page.locator(modelTriggerSelector).click()
  await expect(popover).toBeVisible()
  return popover
}

/**
 * Closes the popover reliably. Selecting an option can leave the row's nested
 * option list open, so a single Escape closes only that list; press until the
 * popover itself is gone.
 */
async function closeModelSettings(page: Page) {
  const popover = page.locator(modelPopoverSelector)
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await popover.isVisible().catch(() => false))) break
    await page.keyboard.press("Escape")
    await popover.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => undefined)
  }
  if (await popover.isVisible().catch(() => false)) {
    await page.locator(modelTriggerSelector).click()
  }
  await expect(popover).toBeHidden()
}

async function pickModelOption(page: Page, kind: "effort" | "speed", id: string) {
  const popover = await openModelSettings(page)
  await popover.locator(`[data-model-menu-row="${kind}"]`).click()
  await popover.locator(`[data-model-option="${kind}"][data-model-option-id="${id}"]`).click()
  await closeModelSettings(page)
}

/** Sets reasoning effort (variant) through the model-settings popover. */
export async function setModelEffort(page: Page, id: string) {
  await pickModelOption(page, "effort", id)
}

/** Sets inference speed (tier) through the model-settings popover. */
export async function setModelSpeed(page: Page, id: string) {
  await pickModelOption(page, "speed", id)
}

/** Reads a menu row's current value ("Auto", "High", "Standard", "Fast", …). */
export async function modelRowValue(page: Page, kind: "effort" | "speed") {
  const popover = await openModelSettings(page)
  const value = (
    await popover.locator(`[data-model-menu-row="${kind}"] [data-model-menu-value] > span`).first().innerText()
  ).trim()
  await closeModelSettings(page)
  return value
}

/** Connects an outside folder through the Files pane UI form. */
export async function connectFolder(page: Page, folder: string, access: "read" | "write") {
  await openFilesSources(page)
  await page.locator("[data-source-button]").click()
  await page.getByRole("button", { name: "Add folder…", exact: true }).click()
  const form = page.getByRole("form", { name: "Connect a folder" })
  await form.getByLabel("Folder path").fill(folder)
  await form.getByLabel("Folder access").selectOption(access)
  await form.getByLabel("Folder access duration").selectOption("session")
  await form.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(form).toBeHidden()
  const name = folder.split("/").filter(Boolean).pop() ?? folder
  await pickSource(page, name)
}
