export function formatCreditBalance(value: number) {
  return `$${value.toFixed(2)}`
}

/**
 * Wallet means purchased credit only. Promotional plan benefits are deliberately
 * absent from this display contract and must never be folded into balanceUsd.
 */
export function walletBalanceLabel(input: { signedIn: boolean; balanceUsd: number | null }) {
  if (!input.signedIn) return "Not signed in"
  if (input.balanceUsd === null) return "Balance unavailable"
  return input.balanceUsd >= 0
    ? `${formatCreditBalance(input.balanceUsd)} available`
    : `${formatCreditBalance(input.balanceUsd)} balance`
}
