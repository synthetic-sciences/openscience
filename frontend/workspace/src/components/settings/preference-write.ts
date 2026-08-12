export async function commitPreference<T>(
  write: () => Promise<T>,
  apply: (value: T) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    apply(await write())
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
