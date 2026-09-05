const names = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "AbortError",
  "TimeoutError",
  "AI_APICallError",
  "AI_RetryError",
  "AI_NoContentGeneratedError",
  "AI_InvalidResponseDataError",
  "AI_TypeValidationError",
  "AI_JSONParseError",
  "AI_LoadAPIKeyError",
  "AI_LoadSettingError",
  "AI_NoSuchModelError",
  "AI_UnsupportedFunctionalityError",
  "AI_InvalidArgumentError",
  "AI_NoSuchToolError",
  "AI_InvalidToolInputError",
])

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

/** SDK stream callbacks wrap errors that can retain the entire conversation,
 * credentials, request URL and response. Log only bounded diagnostic fields;
 * even an exception message or an unknown exception name may contain content. */
export function providerErrorMetadata(value: unknown) {
  const wrapped = record(value)
  const error = "error" in wrapped ? record(wrapped.error) : wrapped
  return {
    errorName: typeof error.name === "string" && names.has(error.name) ? error.name : "Error",
    ...(typeof error.statusCode === "number" &&
      Number.isInteger(error.statusCode) &&
      error.statusCode >= 100 &&
      error.statusCode <= 599 && { statusCode: error.statusCode }),
    ...(typeof error.isRetryable === "boolean" && { isRetryable: error.isRetryable }),
  }
}
