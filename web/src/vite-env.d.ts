/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /** Public anon key only; never the service_role key. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Public contact address shown on the privacy page (set in Vercel). */
  readonly VITE_CONTACT_EMAIL?: string;
  /** Who runs Hivo, named on the privacy page (set in Vercel; never hardcoded). */
  readonly VITE_OPERATOR_NAME?: string;
  /** Optional postal address shown after the operator's name. */
  readonly VITE_OPERATOR_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
