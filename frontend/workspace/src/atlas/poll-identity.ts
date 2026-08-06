// A polling surface has to name itself to the server. Both compute samplers
// measure across the window since THIS caller's previous poll, so two surfaces
// sharing one identity starve each other: whichever polls first each cycle
// advances the shared baseline, and the other's window is always the stagger
// between them — below the one-second floor, refused forever.
//
// Per mount rather than per module: two tabs are two page loads and would get
// separate module state anyway, but two panels in one page would collide on a
// module-level value.
//
// crypto.randomUUID needs a secure context, which localhost is. The fallback
// keeps a reload from ever reusing an identity even where it is unavailable.
export const identify = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
