interface ImportMetaEnv {
  readonly VITE_OPENSCIENCE_SERVER_HOST: string
  readonly VITE_OPENSCIENCE_SERVER_PORT: string
  readonly VITE_OPENSCIENCE_SERVER?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  __OPENSCIENCE_BASE_URL__?: string
}
