/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /** Public anon key only; never the service_role key. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Public contact address shown on the privacy page (set in Vercel). */
  readonly VITE_CONTACT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
