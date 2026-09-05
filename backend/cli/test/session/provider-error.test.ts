import { expect, test } from "bun:test"
import { providerErrorMetadata } from "../../src/session/provider-error"
import { Log } from "../../src/util/log"

test("provider error logs retain identity and status, never SDK request or response content", async () => {
  const marker = `provider-error-${crypto.randomUUID()}`
  const secret = `private-sentinel-${crypto.randomUUID()}`
  const request: Record<string, unknown> = { messages: [{ content: secret }] }
  request.circular = request
  const error = {
    name: "AI_APICallError",
    statusCode: 503,
    isRetryable: true,
    message: secret,
    stack: secret,
    cause: new Error(secret),
    requestBodyValues: request,
    url: `https://example.test/private?token=${secret}`,
    responseBody: secret,
    responseHeaders: { authorization: secret },
    data: { error: { message: secret } },
  }
  const metadata = providerErrorMetadata({ error })
  expect(metadata).toEqual({ errorName: "AI_APICallError", statusCode: 503, isRetryable: true })
  Log.create({ service: "provider-error-test" }).error(marker, metadata)
  await Log.flush()
  const line = (await Bun.file(Log.file()).text()).split("\n").find((line) => line.endsWith(marker))
  expect(line).toContain("errorName=AI_APICallError statusCode=503 isRetryable=true")
  expect(line).not.toContain(secret)
  expect(line).not.toContain("example.test")
  expect(line).not.toContain("requestBodyValues")
})

test("unknown error text and malformed diagnostic fields cannot enter provider logs", () => {
  const secret = "private-sentinel"
  expect(providerErrorMetadata({ name: secret, statusCode: secret, isRetryable: secret })).toEqual({
    errorName: "Error",
  })
  expect(providerErrorMetadata(secret)).toEqual({ errorName: "Error" })
  expect(providerErrorMetadata(new Error(secret))).toEqual({ errorName: "Error" })
  expect(providerErrorMetadata({ error: { name: "AI_APICallError", statusCode: Number.NaN } })).toEqual({
    errorName: "AI_APICallError",
  })
  expect(providerErrorMetadata({ name: "AI_APICallError", statusCode: 999 })).toEqual({ errorName: "AI_APICallError" })
  expect(providerErrorMetadata(new DOMException(secret, "AbortError"))).toEqual({ errorName: "AbortError" })
})
