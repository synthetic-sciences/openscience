export interface ProjectSearchHits {
  sessions: Array<{ id: string; title: string }>
  messages: Array<{ sessionID: string; messageID: string; role: string; snippet: string }>
  artifacts: Array<{ path: string; name: string; kind: string }>
}

export async function requestProjectSearch(run: () => Promise<Response>): Promise<ProjectSearchHits> {
  const response = await run()
  if (!response.ok) throw new Error(`Search failed (${response.status})`)
  return response.json() as Promise<ProjectSearchHits>
}
