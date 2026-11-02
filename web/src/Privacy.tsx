import { useEffect } from "react";
import { LogoLockup } from "./LogoMark";
import type { Lang } from "./lang";
import { PRIVACY, PRIVACY_UPDATED } from "./privacyCopy";

/** /privacy, /en/privacy, /fr/privacy (the address Google Play links to). */
export function isPrivacyPath(path: string): boolean {
  return /^(\/(en|fr))?\/privacy\/?$/.test(path);
}

export function PrivacyPage({ lang }: { lang: Lang }) {
  const t = PRIVACY[lang];
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = `${t.title} · Hivo`;
  }, [lang, t]);

  return (
    <div className="min-h-dvh bg-chassis text-body">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <a href={`/${lang}`} aria-label={t.back}>
            <LogoLockup size={28} />
          </a>
          <nav aria-label={t.language} className="flex gap-3 font-mono text-xs uppercase">
            {(["fr", "en"] as const).map((l) => (
              <a key={l} href={`/${l}/privacy`} hrefLang={l} lang={l} aria-current={l === lang ? "page" : undefined} className={l === lang ? "text-cream" : "text-engrave hover:text-cream"}>
                {l}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-6 py-14">
        <h1 className="font-display text-5xl uppercase leading-[0.95] text-cream md:text-6xl">{t.title}</h1>
        <p className="mt-3 font-mono text-xs text-engrave">
          <time dateTime={PRIVACY_UPDATED}>{t.updated}</time>
        </p>
        <p className="mt-8 text-base leading-relaxed text-body">{t.lead}</p>
        {t.sections.map((s) => (
          <section key={s.title} className="mt-10">
            <h2 className="font-display text-2xl uppercase text-cream">{s.title}</h2>
            {s.body.map((p) => (
              <p key={p} className="mt-3 text-sm leading-relaxed text-body">
                {p}
              </p>
            ))}
          </section>
        ))}
        <p className="mt-14">
          <a href={`/${lang}`} className="font-mono text-xs uppercase tracking-wider text-engrave hover:text-cream">
            ← {t.back}
          </a>
        </p>
      </main>
    </div>
  );
}
