const redirects = new Set([301, 302, 303, 307, 308])

export namespace GitHubAttachment {
  export function parse(input: string) {
    const url = new URL(input)
    const valid =
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname.startsWith("/user-attachments/")

    if (!valid) throw new Error(`Refusing to download non-GitHub attachment URL: ${input}`)
    return url
  }

  export async function download(input: string, token: string) {
    return follow(parse(input), token, 0)
  }

  async function follow(url: URL, token: string, depth: number): Promise<Response> {
    const github = url.hostname === "github.com"
    const res = await fetch(url, {
      headers: {
        ...(github ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/vnd.github.v3+json",
      },
      redirect: "manual",
    })

    if (!redirects.has(res.status)) return res
    if (depth >= 3) throw new Error("GitHub attachment exceeded the redirect limit")

    const location = res.headers.get("location")
    if (!location) throw new Error("GitHub attachment redirect is missing a location")

    const next = new URL(location, url)
    const githubusercontent =
      next.hostname === "objects.githubusercontent.com" ||
      next.hostname === "user-images.githubusercontent.com" ||
      next.hostname === "private-user-images.githubusercontent.com"
    const s3 = /^github-production-user-asset-[a-z0-9-]+\.s3\.amazonaws\.com$/.test(next.hostname)
    const valid = next.protocol === "https:" && next.port === "" && next.username === "" && next.password === ""

    if (!valid || (!githubusercontent && !s3)) {
      throw new Error(`Refusing GitHub attachment redirect to untrusted host: ${next.origin}`)
    }
    return follow(next, token, depth + 1)
  }
}
