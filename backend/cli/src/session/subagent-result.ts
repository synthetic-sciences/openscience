/** Execution facts remain separate from the lead's assessment of the work. */
export namespace SubagentResult {
  export const COMMAND_RECEIPT_CHARS = 12_000

  export function describe(outcome?: string, reason?: string) {
    return [
      `Runtime execution: ${outcome ?? "unknown"}${reason ? ` (${JSON.stringify(reason)})` : ""}.`,
      ...(["budget_limit", "token_limit"].includes(reason ?? "")
        ? [
            "Allowance check: another request cannot be covered. This is not proof that the grant was spent. Use the recorded used and pending amounts; requests refused before dispatch add no model usage.",
          ]
        : []),
      "Task completion: unverified. Check the objective and expected output against the report and saved evidence before using the result.",
    ].join("\n")
  }
}
