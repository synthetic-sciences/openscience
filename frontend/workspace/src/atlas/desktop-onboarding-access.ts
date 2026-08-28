export type ManagedWallet = {
  signedIn: boolean
  balanceUsd: number | null
  managedSupported: boolean
  aceEnabled: boolean
}

export const canUseManaged = (wallet: ManagedWallet | undefined) => Boolean(wallet?.signedIn && wallet.managedSupported)
