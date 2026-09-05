import { describe, expect, test } from "bun:test"
import { gatewayTiming } from "../../src/provider/gateway-timing"
import { Provider } from "../../src/provider/provider"

const id = "0123456789abcdef0123456789abcdef"
const headers = {
  "x-openscience-gateway-request-id": id,
  "server-timing": "os_authenticated;dur=12.5, os_authorized;dur=20, os_upstream_dispatch;dur=30.2",
  authorization: "Bearer private-response-value",
}

describe("managed gateway timing", () => {
  test("an observation callback cannot interrupt dispatch", async () => {
    const response = await Provider.withRequestContext(
      {
        sessionID: "ses_observer",
        messageID: "msg_observer",
        attempt: 1,
        onRequest: () => {
          throw new Error("observer unavailable")
        },
      },
      () =>
        Provider.fetchWithIdleWatchdog(async () => new Response("ok"), "https://provider.test", undefined, {
          providerID: "test-provider",
          modelID: "fixture-model",
        }),
    )
    expect(await response.text()).toBe("ok")
  })

  test("reads only a generated ID and allowlisted numeric offsets", () => {
    expect(
      gatewayTiming(
        new Headers({
          ...headers,
          "server-timing": `${headers["server-timing"]}, private_metric;dur=999, private;desc=\"secret\"`,
        }),
      ),
    ).toEqual({
      gatewayRequestID: id,
      gatewayTiming: { os_authenticated: 12.5, os_authorized: 20, os_upstream_dispatch: 30.2 },
    })
  })

  test.each([
    "os_authenticated;dur=20, os_authorized;dur=10",
    "os_authorized;dur=20, os_authorized;dur=20",
    "os_authorized;dur=9999999999999999999999999999",
  ])("drops ambiguous offsets: %s", (value) => {
    expect(gatewayTiming(new Headers({ ...headers, "server-timing": value }))).toEqual({ gatewayRequestID: id })
  })

  test("drops IDs, descriptions, non-finite metrics and unbounded headers", () => {
    expect(
      gatewayTiming(
        new Headers({
          "x-openscience-gateway-request-id": "Bearer secret",
          "server-timing": 'os_authorized;dur=NaN, os_admitted;dur=-1, os_authenticated;dur=2;desc="secret"',
        }),
      ),
    ).toEqual({})
    expect(gatewayTiming(new Headers({ "server-timing": "x".repeat(4097) }))).toEqual({})
  })

  test.each([true, false])("includes response timing only on a managed request: %s", async (managed) => {
    const timings: Provider.RequestTiming[] = []
    const order: string[] = []
    const response = await Provider.withRequestContext(
      {
        sessionID: "ses_gateway_timing",
        messageID: "msg_gateway_timing",
        attempt: 1,
        onRequest: () => order.push("dispatch"),
      },
      () =>
        Provider.fetchWithIdleWatchdog(
          async () => {
            order.push("fetch")
            return new Response("ok", { headers })
          },
          "https://gateway.test/model",
          undefined,
          {
            providerID: "openrouter",
            modelID: "fixture-model",
            managed,
            onTiming: (item) => timings.push(item),
          },
        ),
    )
    expect(await response.text()).toBe("ok")
    expect(order).toEqual(["dispatch", "fetch"])
    expect(timings).toHaveLength(1)
    expect(timings[0].gatewayRequestID).toBe(managed ? id : undefined)
    expect(timings[0].gatewayTiming).toEqual(managed ? gatewayTiming(new Headers(headers)).gatewayTiming : undefined)
    expect(JSON.stringify(timings)).not.toContain("private-response-value")
    expect(JSON.stringify(timings)).not.toContain("authorization")
  })
})
