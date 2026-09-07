export function formatCreditBalance(value: number) {
  return `$${value.toFixed(2)}`
}

/**
 * Wallet means purchased credit only. Promotional plan benefits are deliberately
 * absent from this display contract and must never be folded into balanceUsd.
 * What can be spent now is the balance minus the gateway's holds for turns in
 * flight, so that figure is the one called "available" whenever it is known.
 */
export function walletBalanceLabel(input: {
  signedIn: boolean
  balanceUsd: number | null
  availableUsd?: number | null
}) {
  if (!input.signedIn) return "Not signed in"
  if (typeof input.availableUsd === "number") return `${formatCreditBalance(input.availableUsd)} available`
  if (input.balanceUsd === null) return "Balance unavailable"
  return input.balanceUsd >= 0
    ? `${formatCreditBalance(input.balanceUsd)} available`
    : `${formatCreditBalance(input.balanceUsd)} balance`
}
