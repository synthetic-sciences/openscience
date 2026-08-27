import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"

type WorkerOptions = { workerSrc: string }

/**
 * Keep the asset import static. Vite applies its URL transform to static
 * dependency imports in both development and production; the previous dynamic
 * import evaluated the worker module itself in development and returned no
 * default URL.
 */
export function ensurePdfWorker(options: WorkerOptions) {
  if (options.workerSrc) return options.workerSrc
  if (typeof workerSrc !== "string" || !workerSrc) throw new Error("The PDF worker asset URL is unavailable.")
  options.workerSrc = workerSrc
  return workerSrc
}
