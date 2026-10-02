export async function work<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Queue concurrency must be a positive integer: ${concurrency}`)
  }
  const pending = [...items]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      // A popped `undefined` is indistinguishable from an exhausted queue, so
      // an item that is itself undefined retired the worker and left every
      // item still queued behind it unprocessed - with the call resolving
      // successfully. The length is the only honest end-of-queue signal.
      while (pending.length > 0) {
        await fn(pending.pop()!)
      }
    }),
  )
}
