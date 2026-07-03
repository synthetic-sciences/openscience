import type { Context } from "hono"
import { WEB_ASSETS, WEB_INDEX } from "./assets"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
}

function contentType(reqPath: string): string {
  const dot = reqPath.lastIndexOf(".")
  if (dot === -1) return "application/octet-stream"
  return MIME[reqPath.slice(dot).toLowerCase()] ?? "application/octet-stream"
}

export async function serveWebAsset(c: Context): Promise<Response | undefined> {
  if (!WEB_INDEX) return undefined

  let reqPath = c.req.path
  if (reqPath === "/") reqPath = "/index.html"

  const direct = WEB_ASSETS[reqPath]
  if (direct) {
    return new Response(Bun.file(direct), {
      headers: { "Content-Type": contentType(reqPath) },
    })
  }

  // Never SPA-fallback for API-shaped paths. If a /api/* route isn't matched
  // by an explicit Hono handler upstream, returning index.html would cause
  // the SPA's JSON.parse to fail with "Unexpected token '<'" — caller should
  // surface a real 404 instead.
  if (reqPath.startsWith("/api/")) return undefined

  // SPA fallback: anything that looks like a client route → index.html.
  // Anything with a file extension that's not a known asset → 404.
  if (reqPath.includes(".") && !reqPath.endsWith(".html")) {
    return c.notFound()
  }

  return new Response(Bun.file(WEB_INDEX), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}
