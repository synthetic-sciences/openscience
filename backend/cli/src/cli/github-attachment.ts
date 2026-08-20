const redirects = new Set([301, 302, 303, 307, 308])

export namespace GitHubAttachment {
  export function parse(input: string) {
    const url = new URL(input)
    const valid =
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === ""

    if (!valid) throw new Error(`Refusing to download non-GitHub attachment URL: ${input}`)

    const asset = /^\/user-attachments\/assets\/([a-zA-Z0-9-]+)$/.exec(url.pathname)
    if (asset) return `https://github.com/user-attachments/assets/${encodeURIComponent(asset[1])}`

    const file = /^\/user-attachments\/files\/(\d+)\/([^/]+)$/.exec(url.pathname)
    if (file) {
      return `https://github.com/user-attachments/files/${encodeURIComponent(file[1])}/${encodeURIComponent(decodeURIComponent(file[2]))}`
    }
    throw new Error(`Refusing to download non-GitHub attachment URL: ${input}`)
  }

  export async function download(input: string, token: string) {
    const res = await fetch(parse(input), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
      },
      redirect: "manual",
    })
    return follow(res, 0)
  }

  async function follow(res: Response, depth: number): Promise<Response> {
    if (!redirects.has(res.status)) return res
    if (depth >= 3) throw new Error("GitHub attachment exceeded the redirect limit")

    const location = res.headers.get("location")
    if (!location) throw new Error("GitHub attachment redirect is missing a location")

    const next = new URL(location, res.url)
    const valid = next.protocol === "https:" && next.port === "" && next.username === "" && next.password === ""

    if (!valid) throw new Error(`Refusing GitHub attachment redirect to untrusted host: ${next.origin}`)

    const origin = (() => {
      if (next.hostname === "objects.githubusercontent.com") return "https://objects.githubusercontent.com"
      if (next.hostname === "user-images.githubusercontent.com") return "https://user-images.githubusercontent.com"
      if (next.hostname === "private-user-images.githubusercontent.com")
        return "https://private-user-images.githubusercontent.com"
      if (next.hostname === "github-production-user-asset-6210df.s3.amazonaws.com")
        return "https://github-production-user-asset-6210df.s3.amazonaws.com"
      throw new Error(`Refusing GitHub attachment redirect to untrusted host: ${next.origin}`)
    })()
    const response = await fetch(`${origin}${next.pathname}${next.search}`, {
      headers: { Accept: "application/vnd.github.v3+json" },
      redirect: "manual",
    })
    return follow(response, depth + 1)
  }
}
