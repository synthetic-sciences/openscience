/** Public Ace terms mirrored by the local client. Atlas remains authoritative.
 * The server charges no service fee on OpenRouter routes: a turn costs the
 * gateway's reported price plus the funding fee, which the pricing catalog
 * may restate per account. */
export const ACE_CONTRACT = Object.freeze({
  activationAuthorizationUsd: 0,
  reloadThresholdUsd: 5,
  reloadAmountUsd: 20,
  fundingFeePercent: 5.5,
  processingFeeDisclosedSeparately: true,
  reloadControlledByAce: true,
})

export function aceActivationCopy(fundingFeePercent = ACE_CONTRACT.fundingFeePercent) {
  return `Ace is a $${ACE_CONTRACT.activationAuthorizationUsd} authorization, not a purchase or subscription. While Ace is on, a purchased Wallet balance below $${ACE_CONTRACT.reloadThresholdUsd} triggers one fixed $${ACE_CONTRACT.reloadAmountUsd} reload; the processing fee is disclosed separately before payment. Ace models are billed at the provider price plus the ${fundingFeePercent}% funding fee, with no other markup.`
}
