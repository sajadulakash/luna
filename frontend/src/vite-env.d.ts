/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The one configuration value the frontend has. No other config, no
      hardcoded URLs anywhere in the source. */
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
