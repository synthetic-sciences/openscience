export namespace Token {
  export function estimate(input: string) {
    const score = { value: 0 }
    for (const char of input || "") {
      // Four ASCII characters per token is a useful English/code heuristic,
      // but applying it to CJK, emoji, or other multibyte scripts can miss the
      // real provider input by several times. Count each non-ASCII code point
      // at least once (and surrogate-pair symbols twice) so preflight and
      // compaction fail safely for multilingual scientific prompts.
      score.value += char.charCodeAt(0) <= 0x7f ? 0.25 : char.length
    }
    return Math.max(0, Math.ceil(score.value))
  }
}
