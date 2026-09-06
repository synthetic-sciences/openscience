import type { AssistantMessage, Part, ReasoningPart, TextPart, UserMessage } from "@synsci/sdk/v2"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { openFilesSources } from "./utils"

test.skip(process.env.OPENSCIENCE_E2E_FAKE_MODEL !== "1", "requires the isolated deterministic model")

const disclosure = '[data-slot="session-turn-collapsible-trigger-content"]'
const reasoningBody = '[data-slot="reasoning-part-body"]'
const expansionKey = "openscience-trace-expansion-v1"

async function placeInViewport(page: Page, control: Locator) {
  await control.evaluate((button) => {
    const scroller = button.closest<HTMLElement>(".session-scroller")!
    scroller.scrollTop += button.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 140
  })
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
    await target.press("Enter")
    await expect(target).toHaveAttribute("aria-expanded", "true")
    await expect(turn(8).locator(reasoningBody)).toContainText("Reasoning complete for experiment 8.")
    await settleLayout(page)
    expect(Math.abs((await target.boundingBox())!.y - keyboardBefore)).toBeLessThanOrEqual(2)
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

    await page.getByRole("button", { name: "Jump to Latest", exact: true }).click()
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
