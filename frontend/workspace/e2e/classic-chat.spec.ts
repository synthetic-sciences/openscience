import type { AssistantMessage, Part, ReasoningPart, TextPart, UserMessage } from "@synsci/sdk/v2"
import type { Locator, Page } from "@playwright/test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { test, expect } from "./fixtures"
import { openFilesSources, promptSelector } from "./utils"
import { SESSION_MESSAGE_CHUNK } from "../src/context/session-hydration"

test.skip(process.env.OPENSCIENCE_E2E_FAKE_MODEL !== "1", "requires the isolated deterministic model")

const disclosure = '[data-slot="session-turn-collapsible-trigger-content"]'
const reasoningBody = '[data-slot="reasoning-part-body"]'
const expansionKey = "openscience-trace-expansion-v1"

async function placeInViewport(page: Page, control: Locator) {
  await page.evaluate(() => document.fonts.ready)
  const viewport = await page.locator(".session-scroller").boundingBox()
  if (!viewport) throw new Error("The conversation did not render")
  // Real scroll intent cancels the route's saved-position restoration. First
  // move the non-sticky turn into view: a pinned button's visual box cannot
  // tell us where its normal-flow position is.
  await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
  await page.mouse.wheel(0, -1)
  await settleLayout(page)
  await control.evaluate((button) => {
    const scroller = button.closest<HTMLElement>(".session-scroller")!
    const turn = button.closest<HTMLElement>("[data-message-id]")!
    scroller.scrollTop += turn.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 24
  })
  await settleLayout(page)
  await control.evaluate((button) => {
    const scroller = button.closest<HTMLElement>(".session-scroller")!
    scroller.scrollTop += button.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 140
  })
  await expect
    .poll(() =>
      control.evaluate((button) =>
        Math.abs(
          button.getBoundingClientRect().top - button.closest(".session-scroller")!.getBoundingClientRect().top - 140,
        ),
      ),
    )
    .toBeLessThanOrEqual(2)
  await settleLayout(page)
  const box = await control.boundingBox()
  if (!box) throw new Error("The disclosure did not render")
  return box.y
}

async function settleLayout(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  )
}

async function dragInspector(page: Page, distance: number, verify: () => Promise<void>) {
  const handle = page.getByRole("separator", { name: "Resize research inspector", exact: true })
  const box = await handle.boundingBox()
  if (!box) throw new Error("The inspector resize handle did not render")
  const before = Number(await handle.getAttribute("aria-valuenow"))
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  try {
    await expect(page.locator("[data-pane-resize-shield]")).toHaveCount(1)
    // Separate pointer moves and layout frames are essential: the drag shield
    // intercepts hit-testing after the first correction, but reading must stay
    // anchored for the entire drag, not just its first frame.
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      await page.mouse.move(x + distance * fraction, y)
      await settleLayout(page)
      await verify()
    }
  } finally {
    await page.mouse.up()
  }
  await expect(page.locator("[data-pane-resize-shield]")).toHaveCount(0)
  expect(Math.abs(Number(await handle.getAttribute("aria-valuenow")) - before)).toBeGreaterThan(100)
}

for (const intent of ["reading", "jump", "navigate"] as const) {
  test(`delayed earlier history respects ${intent} intent`, async ({ page, sdk, gotoSession }) => {
    const session = await sdk.session.create({ title: `History ${intent}` }).then((result) => result.data)
    const other = await sdk.session.create({ title: `Other history ${intent}` }).then((result) => result.data)
    if (!session || !other) throw new Error("The isolated history sessions were not created")
    const release = Promise.withResolvers<void>()
    let pending = false
    let delivered = false
    let closing = false
    try {
      const reply = await sdk.session
        .prompt({
          sessionID: session.id,
          model: { providerID: "e2e", modelID: "echo" },
          parts: [{ type: "text", text: "Seed the isolated history fixture." }],
        })
        .then((result) => result.data)
      const source = await sdk.session
        .messages({ sessionID: session.id })
        .then((result) => result.data?.find((message) => message.info.role === "user")?.info)
      if (!reply || source?.role !== "user") throw new Error("The deterministic history fixture is missing")
      const transcript = (sessionID: string, first: number, count: number, label: string, paragraphs: number) => {
        const parentID = `msg_00000000${String(first).padStart(5, "0")}History`
        return Array.from({ length: count }, (_, index) => {
          const id = `msg_00000000${String(first + index).padStart(5, "0")}History`
          const created = source.time.created - 100_000 + first + index
          const info: UserMessage | AssistantMessage =
            index === 0
              ? { ...source, sessionID, id, time: { created } }
              : { ...reply.info, sessionID, id, parentID, time: { created, completed: created + 1 }, finish: "stop" }
          const parts: Part[] =
            index === 0 || index === count - 1
              ? [
                  {
                    type: "text",
                    id: `prt_${id}`,
                    sessionID,
                    messageID: id,
                    text:
                      index === 0
                        ? `${label} question.`
                        : `## ${label}\n\n` +
                          Array.from(
                            { length: paragraphs },
                            (_, paragraph) =>
                              `${label} observation ${paragraph}: preserve the measured results, uncertainty and experimental controls while reviewing this history.`,
                          ).join("\n\n"),
                  },
                ]
              : []
          return { info, parts }
        })
      }
      // A full message window exposes the real Load earlier messages action.
      // Most assistant steps have no prose, keeping this pagination fixture small.
      const recent = transcript(session.id, 1000, SESSION_MESSAGE_CHUNK, "Current history", 45)
      const earlier = transcript(session.id, 10, 2, "Earlier history", 20)
      const otherMessages = transcript(other.id, 2000, 2, "Other conversation", 20)
      await page.route(new RegExp(`/session/${session.id}/message(?:\\?|$)`), async (route) => {
        const limit = Number(new URL(route.request().url()).searchParams.get("limit"))
        if (limit > SESSION_MESSAGE_CHUNK) {
          pending = true
          await release.promise
        }
        if (closing) return route.abort()
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(limit > SESSION_MESSAGE_CHUNK ? [...earlier, ...recent] : recent),
        })
        if (limit > SESSION_MESSAGE_CHUNK) delivered = true
      })
      await page.route(new RegExp(`/session/${other.id}/message(?:\\?|$)`), (route) =>
        route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(otherMessages) }),
      )
      if (intent === "navigate") {
        // Warm the destination first; revisiting the source would correctly
        // request a larger reconnect window before the pagination under test.
        await gotoSession(other.id)
        await expect(page.getByRole("heading", { name: "Other conversation", exact: true })).toBeVisible()
        await page.getByRole("button", { name: session.title, exact: true }).click()
      } else {
        await gotoSession(session.id)
      }
      await expect(page.getByRole("heading", { name: "Current history", exact: true })).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      const scroller = page.locator(".session-scroller")
      await scroller.evaluate((element) => {
        element.scrollTop = 0
        element.dispatchEvent(new Event("scroll"))
      })
      const anchor = page.locator(`[data-message-id="${recent[0].info.id}"]`)
      const offset = await anchor.evaluate(
        (element) =>
          element.getBoundingClientRect().top - element.closest(".session-scroller")!.getBoundingClientRect().top,
      )
      await page.getByRole("button", { name: "Load earlier messages", exact: true }).click()
      await expect.poll(() => pending).toBe(true)
      const original = await scroller.elementHandle()
      if (intent === "jump") await page.getByRole("button", { name: "Jump to latest", exact: true }).click()
      if (intent === "navigate") {
        await page.locator(`[data-session-tab="${other.id}"]`).click()
        await expect(page.getByRole("heading", { name: "Other conversation", exact: true })).toHaveCount(1)
        await scroller.evaluate((element) => {
          element.scrollTop = 450
          element.dispatchEvent(new Event("scroll"))
        })
      }
      await settleLayout(page)
      const before = await scroller.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }))
      release.resolve()
      await expect.poll(() => delivered).toBe(true)
      if (intent !== "navigate")
        await expect(page.getByRole("heading", { name: "Earlier history", exact: true })).toHaveCount(1)
      // In another session there is no new history heading to await. Sample
      // consecutive paints so a late parsed response and both restore frames
      // cannot land just after a single final-position assertion.
      const frames = await scroller.evaluate(
        (element) =>
          new Promise<number[]>((resolve) => {
            const values: number[] = []
            const sample = () => {
              values.push(element.scrollTop)
              if (values.length === 15) resolve(values)
              else requestAnimationFrame(sample)
            }
            requestAnimationFrame(sample)
          }),
      )
      const after = await scroller.evaluate((element) => ({
        top: element.scrollTop,
        height: element.scrollHeight,
        remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
      }))
      const evidence = test.info().outputPath(`history-${intent}.json`)
      const sameScroller = await original!.evaluate(
        (element) => element === document.querySelector(".session-scroller"),
      )
      await original!.dispose()
      writeFileSync(evidence, JSON.stringify({ intent, before, after, offset, frames, sameScroller }))
      await test.info().attach(`history-${intent}.json`, { path: evidence, contentType: "application/json" })
      if (intent === "reading") {
        const restored = await anchor.evaluate(
          (element) =>
            element.getBoundingClientRect().top - element.closest(".session-scroller")!.getBoundingClientRect().top,
        )
        expect(Math.abs(restored - offset)).toBeLessThanOrEqual(2)
      }
      if (intent === "jump") expect(after.remaining, JSON.stringify({ before, after })).toBeLessThanOrEqual(2)
      if (intent === "navigate")
        expect(
          Math.max(...frames.map((top) => Math.abs(top - before.top))),
          JSON.stringify({ before, after, frames, sameScroller }),
        ).toBeLessThanOrEqual(2)
    } finally {
      closing = true
      release.resolve()
      await sdk.session.delete({ sessionID: session.id }).catch(() => undefined)
      await sdk.session.delete({ sessionID: other.id }).catch(() => undefined)
    }
  })
}

for (const position of ["bottom", "history"] as const) {
  test(`submitting from ${position} keeps long chat mounted while output receipts refresh`, async ({
    page,
    sdk,
    gotoSession,
  }) => {
    const session = await sdk.session.create({ title: `Submit scroll ${position}` }).then((result) => result.data)
    if (!session) throw new Error("The isolated session was not created")
    const sessionID = session.id
    const releaseReceipts = Promise.withResolvers<void>()
    const releasePrompt = Promise.withResolvers<void>()
    let delay = false
    let closing = false
    let receiptsPending = false
    let promptPending = false
    let initialReceipt: { status: number; body: unknown } | undefined
    let receiptChecks = 0
    try {
      const reply = await sdk.session
        .prompt({
          sessionID,
          model: { providerID: "e2e", modelID: "echo" },
          parts: [{ type: "text", text: "Seed the isolated submit fixture." }],
        })
        .then((result) => result.data)
      if (!reply?.info.id) throw new Error("The deterministic model did not return a reply")
      const saved = await sdk.session.messages({ sessionID }).then((result) => result.data ?? [])
      const source = saved.find((message) => message.info.role === "user")?.info
      if (source?.role !== "user") throw new Error("The isolated user turn is missing")
      const filesystem = await sdk.session.filesystem.list({ sessionID }).then((result) => result.data)
      if (!filesystem?.workspace.scratchRoot) throw new Error("The isolated scratch workspace is missing")
      const output = path.join(filesystem.workspace.scratchRoot, "scroll-evidence.txt")
      writeFileSync(output, "Disposable completed-turn output.\n")
      const messages: Array<{ info: UserMessage | AssistantMessage; parts: Part[] }> = []
      for (let index = 0; index < 12; index++) {
        // Older sortable IDs let real optimistic/SSE messages append after
        // this presentation fixture when the actual composer submits.
        const id = `msg_000000000${String(index * 2).padStart(3, "0")}ScrollUser`
        const assistantID = `msg_000000000${String(index * 2 + 1).padStart(3, "0")}ScrollReply`
        const created = source.time.created - 120_000 + index * 2_000
        const parts: Part[] = []
        if (index === 11) {
          parts.push({
            id: "prt_scroll_written",
            messageID: assistantID,
            sessionID,
            type: "tool",
            tool: "bash",
            callID: "call_scroll_written",
            state: {
              status: "completed",
              input: { command: "fixture output" },
              title: "Saved experiment evidence",
              output: "",
              metadata: {
                exit: 0,
                outputFiles: [
                  { path: output, name: "scroll-evidence.txt", size: 34, modified: created, change: "created" },
                ],
              },
              time: { start: created + 100, end: created + 500 },
            },
          })
        }
        parts.push({
          id: `prt_scroll_answer_${index}`,
          messageID: assistantID,
          sessionID,
          type: "text",
          text:
            `## Historical experiment ${index}\n\n` +
            Array.from(
              { length: 7 },
              () =>
                "The measured effect remains uncertain. Preserve the controls and replicate the observation before changing the experimental plan.",
            ).join("\n\n"),
          time: { start: created + 500, end: created + 1_000 },
        })
        messages.push(
          {
            info: { ...source, id, time: { created } },
            parts: [
              {
                id: `prt_scroll_user_${index}`,
                messageID: id,
                sessionID,
                type: "text",
                text: `Review historical experiment ${index}.`,
              },
            ],
          },
          {
            info: {
              ...reply.info,
              id: assistantID,
              parentID: id,
              finish: "stop",
              time: { created: created + 100, completed: created + 1_000 },
            },
            parts,
          },
        )
      }
      await page.route(new RegExp(`/session/${sessionID}/message(?:\\?|$)`), (route) => {
        if (route.request().method() !== "GET") return route.continue()
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(messages) })
      })
      await page.route(/\/file\/resolve(?:\?|$)/, async (route) => {
        const url = new URL(route.request().url())
        if (url.searchParams.get("sessionID") !== sessionID || url.searchParams.get("path") !== output) {
          return route.continue()
        }
        if (delay) {
          receiptsPending = true
          await releaseReceipts.promise
        }
        if (closing) return route.abort()
        const response = await route.fetch()
        receiptChecks++
        initialReceipt ??= { status: response.status(), body: await response.json() }
        await route.fulfill({ response })
      })
      await page.route(/\/runtime\/prompt(?:\?|$)/, async (route) => {
        if (route.request().postDataJSON()?.sessionID === sessionID) {
          promptPending = true
          await releasePrompt.promise
        }
        if (closing) return route.abort()
        await route.continue()
      })
      await gotoSession(sessionID)
      await expect(page.getByRole("heading", { name: "Historical experiment 11", exact: true })).toHaveCount(1)
      await expect.poll(() => initialReceipt?.status).toBe(200)
      await test
        .info()
        .attach("initial-output-check.json", { body: JSON.stringify(initialReceipt), contentType: "application/json" })
      // The status listing omits idle sessions. A real completion while this
      // page is connected supplies the idle SSE state present in an ongoing
      // conversation, before the next composer send changes it to busy.
      const primed = `E2E_OK_${Date.now()}`
      await sdk.session.prompt({
        sessionID,
        model: { providerID: "e2e", modelID: "echo" },
        parts: [{ type: "text", text: `Reply with exactly: ${primed}` }],
      })
      await expect(
        page.locator('[data-slot="session-turn-response-section"]').filter({ hasText: primed }),
      ).toBeVisible()
      await expect.poll(() => receiptChecks).toBeGreaterThan(1)
      await page.evaluate(() => document.fonts.ready)
      const scroller = page.locator(".session-scroller")
      const prompt = page.locator(promptSelector)
      await prompt.click()
      const token = `E2E_OK_${Date.now()}`
      await page.keyboard.type(`Reply with exactly: ${token}`)
      await scroller.evaluate((element, location) => {
        element.scrollTop = location === "bottom" ? element.scrollHeight : element.scrollHeight * 0.45
        element.dispatchEvent(new Event("scroll"))
      }, position)
      await settleLayout(page)
      expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(500)
      const recording = await scroller.evaluateHandle((original) => {
        const samples: Array<{ same: boolean; connected: boolean; top: number; remaining: number }> = []
        let active = true
        const frame = () => {
          const current = document.querySelector<HTMLElement>(".session-scroller")
          samples.push({
            same: current === original,
            connected: original.isConnected,
            top: current?.scrollTop ?? -1,
            remaining: current ? current.scrollHeight - current.clientHeight - current.scrollTop : -1,
          })
          if (active) requestAnimationFrame(frame)
        }
        frame()
        return {
          samples,
          stop: () => {
            active = false
          },
        }
      })
      try {
        delay = true
        await page.keyboard.press("Enter")
        await expect.poll(() => receiptsPending).toBe(true)
        await settleLayout(page)
        const pending = await recording.evaluate((value) => value.samples)
        await test
          .info()
          .attach(`submit-${position}-pending.json`, { body: JSON.stringify(pending), contentType: "application/json" })
        expect(
          pending.every((sample) => sample.same && sample.connected),
          JSON.stringify(pending),
        ).toBe(true)
        expect(Math.min(...pending.map((sample) => sample.top)), JSON.stringify(pending)).toBeGreaterThan(500)
        await expect.poll(() => promptPending).toBe(true)
        releaseReceipts.resolve()
        await settleLayout(page)
        releasePrompt.resolve()
        await expect(
          page.locator('[data-slot="session-turn-response-section"]').filter({ hasText: token }),
        ).toBeVisible()
        await settleLayout(page)
        const completed = await recording.evaluate((value) => value.samples)
        expect(
          completed.every((sample) => sample.same && sample.connected),
          JSON.stringify(completed),
        ).toBe(true)
        expect(Math.min(...completed.map((sample) => sample.top)), JSON.stringify(completed)).toBeGreaterThan(500)
        await expect
          .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
          .toBeLessThanOrEqual(2)
      } finally {
        await recording.evaluate((value) => value.stop())
        const evidence = test.info().outputPath(`submit-${position}-all-frames.json`)
        writeFileSync(
          evidence,
          JSON.stringify({
            receiptsPending,
            promptPending,
            frames: await recording.evaluate((value) => value.samples),
          }),
        )
        await test.info().attach(`submit-${position}-all-frames.json`, {
          path: evidence,
          contentType: "application/json",
        })
        await recording.dispose()
      }
    } finally {
      closing = true
      releaseReceipts.resolve()
      releasePrompt.resolve()
      await sdk.session.abort({ sessionID }).catch(() => undefined)
      await sdk.session.delete({ sessionID }).catch(() => undefined)
    }
  })
}

test("classic long-chat disclosures preserve the reader, stay per-turn, and survive reload", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const session = await sdk.session.create({ title: "Classic chat scroll regression" }).then((result) => result.data)
  if (!session) throw new Error("The isolated session was not created")
  const sessionID = session.id
  try {
    const reply = await sdk.session
      .prompt({
        sessionID,
        model: { providerID: "e2e", modelID: "echo" },
        parts: [{ type: "text", text: "Seed the isolated classic chat fixture." }],
      })
      .then((result) => result.data)
    if (!reply?.info.id) throw new Error("The deterministic model did not return a reply")
    const saved = await sdk.session.messages({ sessionID }).then((result) => result.data ?? [])
    const source = saved.find((message) => message.info.role === "user")?.info
    if (source?.role !== "user") throw new Error("The isolated user turn is missing")

    const ids = Array.from({ length: 12 }, (_, index) => `msg_classic_${String(index * 2).padStart(4, "0")}`)
    const messages: Array<{ info: UserMessage | AssistantMessage; parts: Part[] }> = []
    for (const [index, id] of ids.entries()) {
      const assistantID = `msg_classic_${String(index * 2 + 1).padStart(4, "0")}`
      const created = source.time.created + index * 2_000
      const user: UserMessage = { ...source, id, time: { created } }
      const assistant: AssistantMessage = {
        ...reply.info,
        id: assistantID,
        parentID: id,
        time: { created: created + 100, completed: created + 1_000 },
        finish: "stop",
      }
      const question: TextPart = {
        id: `prt_classic_${index}_0`,
        messageID: id,
        sessionID,
        type: "text",
        text: `Compare the controls for experiment ${index}.`,
      }
      const reasoning: ReasoningPart = {
        id: `prt_classic_${index}_1`,
        messageID: assistantID,
        sessionID,
        type: "reasoning",
        text:
          Array.from(
            { length: 18 },
            (_, paragraph) =>
              `Experiment ${index}, observation ${paragraph}: the control and treatment use the same evaluation conditions. Keep all measured observations and uncertainty visible, with no summary replacing these supplied sentences.`,
          ).join("\n\n") + `\n\nReasoning complete for experiment ${index}.`,
        time: { start: created + 100, end: created + 700 },
      }
      const answer: TextPart = {
        id: `prt_classic_${index}_2`,
        messageID: assistantID,
        sessionID,
        type: "text",
        text:
          `## Conclusion for experiment ${index}.\n\n` +
          Array.from(
            { length: 5 },
            () =>
              "The measured effect remains uncertain. Preserve the controls and replicate the observation before changing the experimental plan.",
          ).join("\n\n"),
        time: { start: created + 700, end: created + 1_000 },
      }
      messages.push({ info: user, parts: [question] }, { info: assistant, parts: [reasoning, answer] })
    }

    // Only this disposable session's transcript response is overridden. The
    // app, scroll hooks, settings persistence, and routing are the real ones.
    await page.route(new RegExp(`/session/${sessionID}/message(?:\\?|$)`), (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(messages),
      }),
    )
    await page.addInitScript(
      ({ key, id }) => {
        if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ [id]: true }))
      },
      { key: expansionKey, id: ids[1] },
    )
    await gotoSession(sessionID)
    await expect(page.locator(disclosure)).toHaveCount(ids.length)
    await page.evaluate(() => document.fonts.ready)
    const turn = (index: number) => page.locator(`[data-message-id="${ids[index]}"]`)
    const target = turn(8).locator(disclosure)
    await expect(turn(1).locator(disclosure)).toHaveAttribute("aria-expanded", "true")
    await expect(target).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator(reasoningBody)).toHaveCount(1)

    const before = await placeInViewport(page, target)
    await target.click()
    await expect(target).toHaveAttribute("aria-expanded", "true")
    await expect(turn(8).locator(reasoningBody)).toContainText("Reasoning complete for experiment 8.")
    await settleLayout(page)
    expect(Math.abs((await target.boundingBox())!.y - before)).toBeLessThanOrEqual(2)
    await expect(page.locator(reasoningBody)).toHaveCount(2)
    await expect(turn(7).locator(disclosure)).toHaveAttribute("aria-expanded", "false")
    await expect(turn(9).locator(disclosure)).toHaveAttribute("aria-expanded", "false")
    await expect(turn(1).locator(disclosure)).toHaveAttribute("aria-expanded", "true")

    await target.click()
    await expect(target).toHaveAttribute("aria-expanded", "false")
    await expect(turn(8).locator(reasoningBody)).toHaveCount(0)
    await settleLayout(page)
    expect(Math.abs((await target.boundingBox())!.y - before)).toBeLessThanOrEqual(2)
    await page.reload()
    await expect(target).toHaveAttribute("aria-expanded", "false")
    await expect(page.locator(reasoningBody)).toHaveCount(1)
    await expect(turn(1).locator(disclosure)).toHaveAttribute("aria-expanded", "true")

    const keyboardBefore = await placeInViewport(page, target)
    await target.focus()
    await settleLayout(page)
    expect(Math.abs((await target.boundingBox())!.y - keyboardBefore)).toBeLessThanOrEqual(2)
    await target.press("Enter")
    await expect(target).toHaveAttribute("aria-expanded", "true")
    await expect(turn(8).locator(reasoningBody)).toContainText("Reasoning complete for experiment 8.")
    await settleLayout(page)
    expect(Math.abs((await target.boundingBox())!.y - keyboardBefore)).toBeLessThanOrEqual(2)

    // Test sticky geometry deliberately, separately from the inset setup.
    await target.evaluate((button) => {
      const scroller = button.closest<HTMLElement>(".session-scroller")!
      scroller.scrollTop += button.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 100
      scroller.dispatchEvent(new Event("scroll"))
    })
    await settleLayout(page)
    const stickyBefore = await target.evaluate((button) => ({
      y: button.getBoundingClientRect().y,
      inset: button.getBoundingClientRect().y - button.closest(".session-scroller")!.getBoundingClientRect().y,
    }))
    expect(Math.abs(stickyBefore.inset)).toBeLessThanOrEqual(4)
    await target.press("Enter")
    await expect(target).toHaveAttribute("aria-expanded", "false")
    await settleLayout(page)
    expect(Math.abs((await target.boundingBox())!.y - stickyBefore.y)).toBeLessThanOrEqual(2)
    await target.press("Enter")
    await expect(target).toHaveAttribute("aria-expanded", "true")
    await expect(turn(8).locator(reasoningBody)).toContainText("Reasoning complete for experiment 8.")
    await settleLayout(page)
    expect(Math.abs((await target.boundingBox())!.y - stickyBefore.y)).toBeLessThanOrEqual(2)
    await page.reload()
    await expect(target).toHaveAttribute("aria-expanded", "true")
    await expect(page.locator(reasoningBody)).toHaveCount(2)
    await expect(turn(7).locator(disclosure)).toHaveAttribute("aria-expanded", "false")
    await expect(turn(1).locator(disclosure)).toHaveAttribute("aria-expanded", "true")

    await page.setViewportSize({ width: 1440, height: 900 })
    await openFilesSources(page)
    await expect(page.locator(".session-right-pane")).toHaveAttribute("data-overlay", "false")
    const handle = page.getByRole("separator", { name: "Resize research inspector", exact: true })
    await handle.press("Home")
    await settleLayout(page)

    const paragraph = turn(9).locator('[data-component="text-part"] p').first()
    await paragraph.evaluate((element) => {
      const scroller = element.closest<HTMLElement>(".session-scroller")!
      scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 8
      scroller.dispatchEvent(new Event("scroll"))
    })
    await settleLayout(page)
    const character = await page.locator(".session-scroller").evaluateHandle((scroller) => {
      const bounds = scroller.getBoundingClientRect()
      for (const offset of [12, 32, 56]) {
        const caret = document.caretPositionFromPoint(bounds.left + scroller.clientWidth / 2, bounds.top + offset)
        if (!caret || caret.offsetNode.nodeType !== Node.TEXT_NODE || !scroller.contains(caret.offsetNode)) continue
        const range = document.createRange()
        const start = Math.min(caret.offset, (caret.offsetNode.textContent?.length ?? 0) - 1)
        if (start < 0) continue
        range.setStart(caret.offsetNode, start)
        range.setEnd(caret.offsetNode, start + 1)
        if (range.getBoundingClientRect().top >= bounds.top) return range
      }
      throw new Error("The fixture reading point must be visible conversation text")
    })
    const textTop = () =>
      character.evaluate((range) => {
        const scroller = range.startContainer.parentElement!.closest(".session-scroller")!
        return range.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      })
    const beforeText = await textTop()
    expect(beforeText).toBeGreaterThanOrEqual(0)
    const checkText = async () => expect(Math.abs((await textTop()) - beforeText)).toBeLessThanOrEqual(2)
    await dragInspector(page, -185, checkText)
    await dragInspector(page, 185, checkText)
    await character.dispose()

    // Heading spacing must not select the preceding offscreen paragraph.
    const heading = turn(9).getByRole("heading", { name: "Conclusion for experiment 9.", exact: true })
    await heading.evaluate((element) => {
      const scroller = element.closest<HTMLElement>(".session-scroller")!
      scroller.scrollTop += element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 44
      scroller.dispatchEvent(new Event("scroll"))
    })
    await settleLayout(page)
    const headingTop = () =>
      heading.evaluate(
        (element) =>
          element.getBoundingClientRect().top - element.closest(".session-scroller")!.getBoundingClientRect().top,
      )
    const beforeHeading = await headingTop()
    const checkHeading = async () => expect(Math.abs((await headingTop()) - beforeHeading)).toBeLessThanOrEqual(2)
    await dragInspector(page, -185, checkHeading)
    await dragInspector(page, 185, checkHeading)

    await page.getByRole("button", { name: "Jump to latest", exact: true }).click()
    await settleLayout(page)
    const checkBottom = async () => {
      const remaining = await page
        .locator(".session-scroller")
        .evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)
      expect(Math.abs(remaining)).toBeLessThanOrEqual(2)
    }
    await checkBottom()
    await dragInspector(page, -185, checkBottom)
    await dragInspector(page, 185, checkBottom)
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
