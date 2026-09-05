import { expect, test } from "bun:test"
import { networkEndpoint } from "./network-endpoint"

const source = Bun.file(new URL("./Network.tsx", import.meta.url)).text()
const styles = Bun.file(new URL("./preference-panels.css", import.meta.url)).text()

test("global network settings do not select a filesystem project", () => {
  const endpoint = new URL(networkEndpoint("http://127.0.0.1:4096/"))

  expect(endpoint.pathname).toBe("/settings/network")
  expect([...endpoint.searchParams]).toEqual([])
})
