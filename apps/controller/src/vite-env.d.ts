/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Relay server URL. Default http://localhost:3001 */
  readonly VITE_RELAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
