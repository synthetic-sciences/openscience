import type { AssistantMessage, Part, ReasoningPart, TextPart, UserMessage } from "@synsci/sdk/v2"
import type { Locator, Page } from "@playwright/test"
import { test, expect } from "./fixtures"

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
          `Conclusion for experiment ${index}.\n\n` +
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
  } finally {
    await sdk.session.delete({ sessionID }).catch(() => undefined)
  }
})
