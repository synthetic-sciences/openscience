import { expect, test } from "bun:test"

const session = await Bun.file(new URL("./session.tsx", import.meta.url)).text()

test("loads older history without moving the visible anchor", () => {
  expect(session).toContain("sync.session.history.loadMore(sessionID)")
  expect(session).toContain('querySelectorAll<HTMLElement>("[data-message-id]")')
  expect(session).toContain("scroller.scrollTop += row.getBoundingClientRect().top - top - offset")
})

test("exposes recoverable archive, turn forks, and compaction handoffs", () => {
  expect(session).toContain("await sync.session.archive(sessionID)")
  expect(session).toContain("time: { archived: 0 }")
  expect(session).toContain("sdk.client.session.fork({ sessionID, messageID })")
  expect(session).toContain("<CompactionBoundary")
  expect(session).toContain("props.part?.handoffFile")
})
