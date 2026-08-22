/**
 * Normalized model usage follows the AI SDK contract: `output` already
 * includes reasoning tokens. `reasoning` is a displayed subset of `output`,
 * never an additional quantity to bill or add to a context total.
 */
export namespace TokenUsage {
  export type Value = {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }

  /** Fresh input plus inclusive output, excluding cached-input detail. */
  export function uncached(value: Value) {
    return value.input + value.output
  }

  /** Complete normalized usage, with cached input counted exactly once. */
  export function total(value: Value) {
    return uncached(value) + value.cache.read + value.cache.write
  }
}
