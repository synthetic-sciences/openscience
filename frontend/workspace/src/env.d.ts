/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENSCIENCE_VERSION?: string
  readonly VITE_OPENSCIENCE_SERVER_HOST: string
  readonly VITE_OPENSCIENCE_SERVER_PORT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  __OPENSCIENCE_BASE_URL__?: string
}
