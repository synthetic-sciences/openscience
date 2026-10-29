/** Public reload terms mirrored by the local client. Dashboard remains authoritative. */
export const ACE_CONTRACT = Object.freeze({
  activationAuthorizationUsd: 0,
  reloadThresholdUsd: 5,
  reloadAmountUsd: 20,
  processingFeeDisclosedSeparately: true,
  reloadControlledByAce: false,
})

export function aceActivationCopy() {
  return `Turning on Ace costs $${ACE_CONTRACT.activationAuthorizationUsd} and does not authorize automatic card charges. Auto-reload is a separate opt-in with a saved card: it adds $${ACE_CONTRACT.reloadAmountUsd} when purchased funds fall below $${ACE_CONTRACT.reloadThresholdUsd}, plus the separately disclosed processing fee. Ace usage is billed at the Wallet rates shown for the selected model and speed.`
}
