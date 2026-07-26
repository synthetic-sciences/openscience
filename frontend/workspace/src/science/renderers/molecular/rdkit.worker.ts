import type { JSMol, RDKitLoader, RDKitModule } from "@rdkit/rdkit"

interface RenderRequest {
  input: string
  width: number
  height: number
}

type RenderResponse = { ok: true; svg: string } | { ok: false; error: string }

let rdkitPromise: Promise<RDKitModule> | undefined

async function getRDKit(): Promise<RDKitModule> {
  if (!rdkitPromise) {
    rdkitPromise = (async () => {
      try {
        const init = ((await import("@rdkit/rdkit")) as unknown as { default: RDKitLoader }).default
        const wasmUrl = ((await import("@rdkit/rdkit/dist/RDKit_minimal.wasm?url")) as unknown as {
          default: string
        }).default
        return await init({ locateFile: () => wasmUrl })
      } catch (error) {
        rdkitPromise = undefined
        throw error
      }
    })()
  }
  return rdkitPromise
}

globalThis.onmessage = async (event: MessageEvent<RenderRequest>) => {
  const reply = event.ports[0]
  if (!reply) return

  let mol: JSMol | null | undefined
  try {
    const rdkit = await getRDKit()
    mol = rdkit.get_mol(event.data.input)
    if (!mol || !mol.is_valid()) throw new Error("could not parse molecule (invalid SMILES/Mol block)")
    reply.postMessage({ ok: true, svg: mol.get_svg(event.data.width, event.data.height) } satisfies RenderResponse)
  } catch (error) {
    reply.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies RenderResponse)
  } finally {
    mol?.delete()
    reply.close()
  }
}
