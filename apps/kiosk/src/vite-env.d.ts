/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** This kiosk's room id. Default "gt-entrance" */
  readonly VITE_SESSION_ID?: string;
  /** Base URL of the controller app the QR points at. For phone testing set this to
   *  your machine's LAN address, e.g. http://192.168.1.20:5174 */
  readonly VITE_CONTROLLER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
