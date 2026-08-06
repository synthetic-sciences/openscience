import { createEffect, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { KernelStatus } from "@/notebook/runtime"

// Every poll parses a brand new response body, so feeding the resource
// straight into <For> would tear down and remount every kernel card on each
// 2.5s tick. Reconciling into a store keyed by the kernel's stable id keeps an
// unchanged kernel's object identity intact, so <For> leaves its card mounted;
// only a kernel whose fields actually changed gets patched in place. The list
// is genuinely dynamic (kernels appear, disappear, and get re-sorted by
// last_activity_at), so Index — which keys by position — is the wrong tool.
export function useKernelList(source: Accessor<KernelStatus[] | undefined>) {
  const [kernels, setKernels] = createStore<KernelStatus[]>([])
  createEffect(() => setKernels(reconcile(source() ?? [], { key: "id" })))
  return kernels
}
