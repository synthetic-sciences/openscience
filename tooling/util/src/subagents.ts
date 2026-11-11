/** Suggested limits take effect only after the user enables bounded runs. */
export const SubagentDefaults = {
  enabled: false,
  usd: 5,
  tokens: 1_000_000,
  deadlineMs: 600_000,
  usdIncrease: 1,
  tokenIncrease: 250_000,
} as const
