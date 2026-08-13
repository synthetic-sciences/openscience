import { createOpenScienceRuntime, type RuntimePromptInput } from "../src/v2/runtime.js"
import type { RuntimeEvent, RuntimeEventReplay, RuntimePromptAccepted } from "../src/v2/gen/types.gen.js"

type Assert<T extends true> = T
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

type _promptInput = Assert<
  Equal<RuntimePromptInput, { sessionID: string; message: string; effort: "normal" | "ultra" }>
>
type _promptResult = Assert<
  Equal<Awaited<ReturnType<ReturnType<typeof createOpenScienceRuntime>["prompt"]>>, RuntimePromptAccepted>
>
type _replayResult = Assert<
  Equal<Awaited<ReturnType<ReturnType<typeof createOpenScienceRuntime>["replay"]>>, RuntimeEventReplay>
>
type _eventsResult = Assert<
  Equal<ReturnType<ReturnType<typeof createOpenScienceRuntime>["events"]>, AsyncGenerator<RuntimeEvent, void, void>>
>

export const runtimeContract = {
  promptInput: true as _promptInput,
  promptResult: true as _promptResult,
  replayResult: true as _replayResult,
  eventsResult: true as _eventsResult,
}
