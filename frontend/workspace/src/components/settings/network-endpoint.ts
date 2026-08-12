export function networkEndpoint(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/settings/network`
}
