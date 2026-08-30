/** Public Ace terms mirrored by the local client. Atlas remains authoritative. */
export const ACE_CONTRACT = Object.freeze({
  activationAuthorizationUsd: 0,
  reloadThresholdUsd: 5,
  reloadAmountUsd: 20,
  serviceMarginPercent: 2,
  processingFeeDisclosedSeparately: true,
  reloadControlledByAce: true,
})

export function aceActivationCopy() {
  return `Ace is a $${ACE_CONTRACT.activationAuthorizationUsd} authorization, not a purchase or subscription. While Ace is on, a purchased Wallet balance below $${ACE_CONTRACT.reloadThresholdUsd} triggers one fixed $${ACE_CONTRACT.reloadAmountUsd} reload; the processing fee is disclosed separately before payment.`
}
