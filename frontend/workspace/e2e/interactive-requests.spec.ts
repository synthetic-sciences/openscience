import type { APIRequestContext } from "@playwright/test"
import { test, expect } from "./fixtures"
import { createSdk, serverUrl } from "./utils"

const E2E_TOOL_SENTINELS = {
  question: "E2E_TOOL_QUESTION",
  permission: "E2E_TOOL_PERMISSION",
} as const

test.skip(
  process.env.OPENSCIENCE_E2E_FAKE_MODEL !== "1",
  "requires the deterministic model supplied by test:e2e:local (or the E2E CI harness)",
)

test.describe.configure({ mode: "serial" })

type Sdk = ReturnType<typeof createSdk>
type PendingRequest = { id: string; sessionID: string }

async function listPending(
  request: APIRequestContext,
  kind: "permission" | "question",
  sessionID: string,
  directory: string,
) {
  const response = await request.get(`${serverUrl}/${kind}?directory=${encodeURIComponent(directory)}`)
  expect(response.ok()).toBe(true)
  const pending = (await response.json()) as PendingRequest[]
  return pending.filter((item) => item.sessionID === sessionID)
}

async function cleanupPending(request: APIRequestContext, sessionID: string, directory: string) {
  const query = `?directory=${encodeURIComponent(directory)}`
  for (const item of await listPending(request, "permission", sessionID, directory)) {
    await request.post(`${serverUrl}/permission/${encodeURIComponent(item.id)}/reply${query}`, {
      data: { reply: "reject" },
    })
  }
  for (const item of await listPending(request, "question", sessionID, directory)) {
    await request.post(`${serverUrl}/question/${encodeURIComponent(item.id)}/reject${query}`)
  }
}

async function cleanupSession(request: APIRequestContext, sessionID: string, directory: string) {
  const query = `?directory=${encodeURIComponent(directory)}`
  await cleanupPending(request, sessionID, directory)
  await request
    .delete(`${serverUrl}/session/${encodeURIComponent(sessionID)}${query}`, { timeout: 5_000 })
    .catch(() => undefined)
}

async function assistantText(sdk: Sdk, sessionID: string) {
  const messages = await sdk.session.messages({ sessionID, limit: 50 }).then((response) => response.data ?? [])
  return messages
    .filter((message) => message.info.role === "assistant")
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}

async function toolStatus(sdk: Sdk, sessionID: string) {
  const messages = await sdk.session.messages({ sessionID, limit: 50 }).then((response) => response.data ?? [])
  return messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === "tool")
    .at(-1)?.state.status
}

async function sendSentinel(
  input: {
    sdk: Sdk
    gotoSession: (sessionID?: string) => Promise<void>
  },
  kind: keyof typeof E2E_TOOL_SENTINELS,
) {
  const created = await input.sdk.session.create({ title: `e2e ${kind} request ${Date.now()}` }).then((r) => r.data)
  if (!created?.id) throw new Error("Session create did not return an id")

  const sentinel = `${E2E_TOOL_SENTINELS[kind]}_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`
  await input.gotoSession(created.id)
  await input.sdk.session.promptAsync({
    sessionID: created.id,
    model: { providerID: "e2e", modelID: "echo" },
    parts: [{ type: "text", text: sentinel }],
  })
  return { sessionID: created.id, sentinel }
}

async function expectCompleted(sdk: Sdk, sessionID: string, sentinel: string) {
  await expect.poll(() => assistantText(sdk, sessionID), { timeout: 20_000 }).toContain(`${sentinel}_DONE`)
  await expect.poll(() => toolStatus(sdk, sessionID), { timeout: 20_000 }).toBe("completed")
}

async function expectRejected(sdk: Sdk, sessionID: string) {
  await expect.poll(() => toolStatus(sdk, sessionID), { timeout: 20_000 }).toBe("error")
}

test("question prompt replies through the real pending request", async ({ page, sdk, directory, gotoSession }) => {
  test.setTimeout(90_000)
  const { sessionID, sentinel } = await sendSentinel({ sdk, gotoSession }, "question")

  try {
    const prompt = page.locator('[data-component="question-prompt"]')
    await expect.poll(() => listPending(page.request, "question", sessionID, directory)).toHaveLength(1)
    await expect(prompt).toBeVisible({ timeout: 20_000 })

    await prompt.locator('[data-slot="question-option"]').filter({ hasText: "Continue" }).click()

    await expect(prompt).toHaveCount(0)
    await expect.poll(() => listPending(page.request, "question", sessionID, directory)).toHaveLength(0)
    await expectCompleted(sdk, sessionID, sentinel)
  } finally {
    await cleanupSession(page.request, sessionID, directory)
  }
})

test("question prompt can be rejected through the real pending request", async ({
  page,
  sdk,
  directory,
  gotoSession,
}) => {
  test.setTimeout(90_000)
  const { sessionID } = await sendSentinel({ sdk, gotoSession }, "question")

  try {
    const prompt = page.locator('[data-component="question-prompt"]')
    await expect.poll(() => listPending(page.request, "question", sessionID, directory)).toHaveLength(1)
    await expect(prompt).toBeVisible({ timeout: 20_000 })

    await prompt.getByRole("button", { name: "Dismiss", exact: true }).click()

    await expect(prompt).toHaveCount(0)
    await expect.poll(() => listPending(page.request, "question", sessionID, directory)).toHaveLength(0)
    await expectRejected(sdk, sessionID)
  } finally {
    await cleanupSession(page.request, sessionID, directory)
  }
})

test("permission prompt allows a harmless read once", async ({ page, sdk, directory, gotoSession }) => {
  test.setTimeout(90_000)
  const { sessionID, sentinel } = await sendSentinel({ sdk, gotoSession }, "permission")

  try {
    const prompt = page.locator('[data-component="permission-prompt"]')
    await expect.poll(() => listPending(page.request, "permission", sessionID, directory)).toHaveLength(1)
    await expect(prompt).toBeVisible({ timeout: 20_000 })

    await prompt.getByRole("button", { name: "Allow once", exact: true }).click()

    await expect(prompt).toHaveCount(0)
    await expect.poll(() => listPending(page.request, "permission", sessionID, directory)).toHaveLength(0)
    await expectCompleted(sdk, sessionID, sentinel)
  } finally {
    await cleanupSession(page.request, sessionID, directory)
  }
})

test("permission prompt denies a harmless read", async ({ page, sdk, directory, gotoSession }) => {
  test.setTimeout(90_000)
  const { sessionID } = await sendSentinel({ sdk, gotoSession }, "permission")

  try {
    const prompt = page.locator('[data-component="permission-prompt"]')
    await expect.poll(() => listPending(page.request, "permission", sessionID, directory)).toHaveLength(1)
    await expect(prompt).toBeVisible({ timeout: 20_000 })

    await prompt.getByRole("button", { name: "Deny", exact: true }).click()

    await expect(prompt).toHaveCount(0)
    await expect.poll(() => listPending(page.request, "permission", sessionID, directory)).toHaveLength(0)
    await expectRejected(sdk, sessionID)
  } finally {
    await cleanupSession(page.request, sessionID, directory)
  }
})
