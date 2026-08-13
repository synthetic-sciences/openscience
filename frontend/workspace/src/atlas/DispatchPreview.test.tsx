import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import type { JSX } from "solid-js"
import { createServer } from "vite"
import solid from "vite-plugin-solid"
import type { Staged } from "./DispatchPreview"

const cleanups: Array<() => void> = []
const server = await createServer({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  mode: "production",
  logLevel: "silent",
  plugins: [solid({ ssr: false, dev: false })],
  server: { middlewareMode: true },
  appType: "custom",
  resolve: { conditions: ["browser", "production"], dedupe: ["solid-js", "solid-js/web"] },
  ssr: {
    noExternal: true,
    resolve: { conditions: ["browser", "production"] },
  },
})
const [subject, web] = await Promise.all([
  server.ssrLoadModule("/src/atlas/DispatchPreview.tsx") as Promise<typeof import("./DispatchPreview")>,
  server.ssrLoadModule("solid-js/web") as Promise<typeof import("solid-js/web")>,
])

afterAll(() => server.close())

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  document.body.replaceChildren()
})

const mount = (view: () => JSX.Element) => {
  const host = document.createElement("div")
  document.body.append(host)
  cleanups.push(web.render(view, host))
  return host
}

const staged = (value: Partial<Staged> = {}): Staged => ({
  purpose: "Train the approved model and save evaluation metrics.",
  command: "python train.py --config config.yaml",
  cwd: "/work/project",
  ...value,
})

describe("dispatch preview", () => {
  test("shows the exact local command and where it runs before dispatch", () => {
    const host = mount(() => subject.DispatchPreview({ staged: staged() }))

    expect(host.querySelector('[data-testid="dispatch-preview"]')).not.toBeNull()
    expect(host.textContent).toContain("This will run:")
    expect(host.textContent).toContain("python train.py --config config.yaml")
    expect(host.textContent).toContain("This computer")
    expect(host.textContent).toContain("/work/project")
    expect(host.textContent).toContain("Runs on this computer in your login shell.")
  })

  test("states the sbatch wrapping honestly without fabricating the wrapper command line", () => {
    const host = mount(() =>
      subject.DispatchPreview({
        staged: staged({
          remote: { kind: "ssh", label: "Cluster", host: "hpc.example.edu", scheduler: "slurm" },
          resources: { cpus: 4, gpus: 1, memory_gb: 16, time_minutes: 120, partition: "gpu" },
          modules: ["cuda/12.4"],
        }),
      }),
    )

    expect(host.textContent).toContain("python train.py --config config.yaml")
    expect(host.textContent).toContain("Cluster · hpc.example.edu")
    expect(host.textContent).toContain("Slurm · sbatch")
    expect(host.textContent).toContain("wrapped for sbatch on dispatch")
    expect(host.textContent).toContain("become sbatch resource flags")
    expect(host.textContent).toContain("4 CPU · 1 GPU · 16 GB · 120 min · gpu")
    expect(host.textContent).toContain("module load cuda/12.4 runs before the command")
    expect(host.textContent).not.toContain("sbatch --wait")
    expect(host.textContent).not.toContain("--wrap=")
  })

  test("states the qsub script submission honestly, including the unapplied queue value", () => {
    const host = mount(() =>
      subject.DispatchPreview({
        staged: staged({
          remote: { kind: "ssh", label: "Campus PBS", host: "pbs.example.edu", scheduler: "pbs" },
          resources: { cpus: 2, time_minutes: 30, partition: "batch" },
          container: "pytorch.sif",
        }),
      }),
    )

    expect(host.textContent).toContain("PBS · qsub")
    expect(host.textContent).toContain("submitted as a qsub batch script on dispatch")
    expect(host.textContent).toContain("become qsub resource limits")
    expect(host.textContent).toContain("queue or partition value is not applied to qsub")
    expect(host.textContent).toContain("apptainer exec pytorch.sif")
    expect(host.textContent).not.toContain("qsub -W")
  })

  test("states plain SSH execution for hosts without a scheduler", () => {
    const host = mount(() =>
      subject.DispatchPreview({
        staged: staged({ remote: { kind: "ssh", label: "GPU box", host: "gpu.example.edu", scheduler: "none" } }),
      }),
    )

    expect(host.textContent).toContain("GPU box · gpu.example.edu")
    expect(host.textContent).toContain("run with bash -lc")
  })

  test("warns that modules and images stay unapplied on local runs", () => {
    const notes = subject.previewNotes(staged({ modules: ["cuda/12.4"], container: "pytorch.sif" }))
    expect(notes.join(" ")).toContain("applied only on remote hosts")
  })

  test("enables dispatch only after the command was reviewed", () => {
    const purpose = "Compare candidate models"
    expect(subject.dispatchReady({ name: "run", purpose, command: "python x.py", reviewed: false, busy: false })).toBe(
      false,
    )
    expect(subject.dispatchReady({ name: "run", purpose, command: "python x.py", reviewed: true, busy: true })).toBe(
      false,
    )
    expect(subject.dispatchReady({ name: " ", purpose, command: "python x.py", reviewed: true, busy: false })).toBe(
      false,
    )
    expect(
      subject.dispatchReady({ name: "run", purpose: " ", command: "python x.py", reviewed: true, busy: false }),
    ).toBe(false)
    expect(subject.dispatchReady({ name: "run", purpose, command: " ", reviewed: true, busy: false })).toBe(false)
    expect(subject.dispatchReady({ name: "run", purpose, command: "python x.py", reviewed: true, busy: false })).toBe(
      true,
    )
  })
})
