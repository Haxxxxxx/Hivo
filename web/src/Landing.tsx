import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Check, Download, Minus } from "lucide-react";
import { LogoLockup, LogoMark } from "./LogoMark";
import { STATUSES } from "@shared/lib/songs";
import { LANDING, type LandingCopy } from "./landingCopy";
import type { Lang } from "./lang";

// The signed-out front door, "studio wall" style: loud condensed type, mono
// for data, real screenshots (sample data), crew voice. English and French
// (landingCopy.ts): /fr and /en pick one, / follows the browser. Every claim
// has to be true of the shipped app: when a feature changes, change both.

/** The updater manifest the release workflow uploads (`latest.json` at the
 * root of the public `releases` bucket): the version line shows what's
 * actually downloadable, never a hardcoded number. */
const MANIFEST_URL = import.meta.env.VITE_SUPABASE_URL ? `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/object/public/releases/latest.json` : null;
const MAC_DAMAGED_FIX = 'xattr -cr "/Applications/Hivo.app"';

/** The latest released version, or null (not loaded, unreachable, malformed): then the version line is hidden. */
function useLatestVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!MANIFEST_URL) return;
    const ctrl = new AbortController();
    fetch(MANIFEST_URL, { signal: ctrl.signal, cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m: unknown) => {
        const v = m && typeof m === "object" ? (m as { version?: unknown }).version : null;
        if (typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)) setVersion(v);
      })
      .catch(() => {
        // Offline or blocked: the page simply shows no version.
      });
    return () => ctrl.abort();
  }, []);
  return version;
}

/** The Play Store listing. Empty until the app is published there: the button stays hidden. */
const PLAY_URL: string = "";

const primary = "inline-flex items-center gap-2 rounded bg-hot px-5 py-2.5 font-display uppercase tracking-[0.06em] text-base font-bold text-chassis hover:bg-hot-hover";
const ghost = "inline-flex items-center gap-2 rounded border border-rule-strong px-5 py-2.5 font-display uppercase tracking-[0.06em] text-base font-semibold text-cream hover:bg-raised";
const kicker = "font-mono text-[11px] uppercase tracking-[0.14em] text-hot";
const h2 = "font-display text-4xl uppercase leading-[0.95] text-cream md:text-6xl";

export function Landing({ signIn, lang }: { signIn: ReactNode; lang: Lang }) {
  const t = LANDING[lang];
  const version = useLatestVersion();
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = t.meta.title;
    document.querySelector('meta[name="description"]')?.setAttribute("content", t.meta.description);
  }, [lang, t]);

  return (
    <div className="min-h-dvh overflow-x-hidden bg-chassis text-body">
      <Nav t={t} lang={lang} />
      <main>
        <Hero t={t} version={version} />
        <Daws t={t} />
        <Stages t={t} />
        <div id="features" className="scroll-mt-20">
          <Feature n="01" copy={t.library} shot="song-panel" t={t} />
          <Feature flip n="02" copy={t.board} shot="pipeline" t={t} />
        </div>
        <LaunchKit t={t} />
        <Crew t={t} />
        <Privacy t={t} />
        <Status t={t} version={version} />
        <Faq t={t} />
        <section id="signin" className="scroll-mt-20 border-t border-rule px-6 py-24">
          <div className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[1.1fr_1fr] md:items-center">
            <div>
              <h2 className={h2}>{t.signin.title}</h2>
              <p className="mt-5 max-w-md text-base leading-relaxed text-body">{t.signin.lead}</p>
              <p className="mt-3 max-w-md text-sm text-body">{t.signin.app}</p>
              <div className="mt-5 flex flex-wrap gap-3">
                <a href="/download/mac" className={ghost}>
                  <Download size={16} strokeWidth={2.5} /> {t.signin.mac}
                </a>
                <a href="/download/windows" className={ghost}>
                  <Download size={16} strokeWidth={2.5} /> {t.signin.windows}
                </a>
              </div>
              <ul className="mt-3 max-w-md space-y-1.5 font-mono text-xs text-engrave">
                <li>{t.signin.firstRun.mac}</li>
                <li>
                  {t.signin.firstRun.damaged}{" "}
                  <code className="select-all rounded bg-panel px-1 py-0.5 text-body">{MAC_DAMAGED_FIX}</code>
                </li>
                <li>{t.signin.firstRun.windows}</li>
              </ul>
              <p className="mt-6 max-w-md text-sm text-body">{t.signin.phone}</p>
              <div className="mt-4 flex flex-wrap gap-3">
                <a href="/download/android" className={ghost}>
                  <Download size={16} strokeWidth={2.5} /> {t.signin.android}
                </a>
                {PLAY_URL && (
                  <a href={PLAY_URL} className={ghost} rel="noopener">
                    {t.signin.play}
                  </a>
                )}
              </div>
              <p className="mt-3 max-w-md font-mono text-xs text-engrave">{t.signin.androidTip}</p>
            </div>
            <div className="rounded-2xl border border-rule bg-panel p-6">{signIn}</div>
          </div>
        </section>
      </main>
      <Footer t={t} lang={lang} version={version} />
    </div>
  );
}

/** FR | EN: real links (/fr, /en), so each language has its own address. */
function LangSwitch({ lang, label }: { lang: Lang; label: string }) {
  return (
    <nav aria-label={label} className="flex items-center gap-1 font-mono text-xs">
      {(["fr", "en"] as const).map((l, i) => (
        <span key={l} className="flex items-center gap-1">
          {i > 0 && (
            <span className="text-engrave" aria-hidden>
              |
            </span>
          )}
          <a
            href={`/${l}`}
            hrefLang={l}
            lang={l}
            aria-current={l === lang ? "page" : undefined}
            className={`rounded px-1.5 py-1 uppercase ${l === lang ? "text-cream" : "text-engrave hover:text-cream"}`}
          >
            {l === "fr" ? "FR" : "EN"}
            <span className="sr-only">{l === "fr" ? " (français)" : " (English)"}</span>
          </a>
        </span>
      ))}
    </nav>
  );
}

function Nav({ t, lang }: { t: LandingCopy; lang: Lang }) {
  const links: [string, string][] = [
    ["#features", t.nav.features],
    ["#launch-kit", t.nav.launchKit],
    ["#privacy", t.nav.privacy],
    ["#status", t.nav.status],
    ["#faq", t.nav.faq],
  ];
  return (
    <header className="sticky top-0 z-20 border-b border-rule bg-chassis/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-8 px-6 py-4">
        <a href="#top" aria-label={t.nav.home}>
          <LogoLockup size={32} />
        </a>
        <nav aria-label={t.nav.sections} className="hidden gap-6 text-sm text-body lg:flex">
          {links.map(([href, label]) => (
            <a key={href} href={href} className="hover:text-cream">
              {label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <LangSwitch lang={lang} label={t.nav.switchTo} />
          <a href="#signin" className="rounded-lg border border-rule-strong px-4 py-2 text-sm font-semibold text-cream hover:bg-raised">
            {t.nav.signIn}
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero({ t, version }: { t: LandingCopy; version: string | null }) {
  return (
    <section id="top" className="scroll-mt-20 px-6 pt-16 md:pt-24">
      <div className="mx-auto max-w-6xl">
        <h1 className="font-display text-[3.4rem] uppercase leading-[0.92] text-cream sm:text-7xl md:text-[7.5rem]">
          {t.hero.q1}
          <br />
          <span className="text-body">{t.hero.q2}</span>
          <br />
          <span className="text-hot">{t.hero.q3}</span>
        </h1>
        <p className="mt-8 max-w-2xl text-lg leading-relaxed text-body">{t.hero.lead}</p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <a href="#signin" className={primary}>
            {t.hero.cta} <ArrowRight size={16} strokeWidth={2.5} />
          </a>
          <a href="#features" className={ghost}>
            {t.hero.secondary}
          </a>
        </div>
        <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 font-mono text-xs text-body" aria-label={t.hero.glance}>
          {[...t.hero.facts, ...(version ? [`v${version}`] : [])].map((f) => (
            <li key={f} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden /> {f}
            </li>
          ))}
        </ul>
      </div>
      <div className="mx-auto mt-16 max-w-6xl">
        <Shot name="dashboard" caption={t.hero.shotCaption} alt={t.hero.shotAlt} fullSize={t.shot.fullSize} eager />
      </div>
    </section>
  );
}

/** 1440 px for phones and regular screens, 2880 px for retina. */
function Shot({ name, alt, caption, fullSize, eager = false }: { name: string; alt: string; caption: string; fullSize: string; eager?: boolean }) {
  return (
    <figure>
      {/* Tap or click for the full-size image (hard to read on a phone otherwise). */}
      <a
        href={`/shots/${name}.jpg`}
        target="_blank"
        rel="noopener"
        aria-label={`${alt} (${fullSize})`}
        className="block overflow-hidden rounded-md border border-rule-strong shadow-[0_30px_80px_-20px_rgba(0,0,0,0.85)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cream"
      >
        <img
          src={`/shots/${name}-1440.jpg`}
          srcSet={`/shots/${name}-1440.jpg 1440w, /shots/${name}.jpg 2880w`}
          sizes="(min-width: 1200px) 1152px, 100vw"
          alt={alt}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          width={1440}
          height={900}
          className="block h-auto w-full"
        />
      </a>
      <figcaption className="mt-3 font-mono text-[11px] text-engrave">{caption}</figcaption>
    </figure>
  );
}

const READ_INSIDE = [
  ["FL Studio", ".flp"],
  ["Ableton Live", ".als"],
  ["REAPER", ".rpp"],
  ["Studio One", ".song"],
];
const TRACKED = [
  ["Pro Tools", ".ptx"],
  ["Cubase", ".cpr"],
  ["Bitwig Studio", ".bwproject"],
];

function Daws({ t }: { t: LandingCopy }) {
  const chip = (name: string, ext: string) => (
    <li key={name} className="flex items-baseline justify-between gap-3 border-b border-rule py-2.5">
      <span className="font-display text-xl uppercase text-cream">{name}</span>
      <span className="font-mono text-xs text-engrave">{ext}</span>
    </li>
  );
  return (
    <section className="px-6 pt-28" aria-labelledby="daws-title">
      <div className="mx-auto max-w-6xl">
        <p className={kicker}>{t.daws.kicker}</p>
        <h2 id="daws-title" className={`mt-4 ${h2}`}>
          {t.daws.title}
        </h2>
        <p className="mt-4 max-w-2xl text-base text-body">{t.daws.lead}</p>
        <div className="mt-10 grid gap-10 md:grid-cols-2">
          <div>
            <h3 className="font-mono text-xs uppercase tracking-wider text-cream">{t.daws.insideTitle}</h3>
            <p className="mt-1 text-sm text-body md:min-h-10">{t.daws.insideBody}</p>
            <ul className="mt-3">{READ_INSIDE.map(([n, e]) => chip(n, e))}</ul>
          </div>
          <div>
            <h3 className="font-mono text-xs uppercase tracking-wider text-cream">{t.daws.trackedTitle}</h3>
            <p className="mt-1 text-sm text-body md:min-h-10">{t.daws.trackedBody}</p>
            <ul className="mt-3">{TRACKED.map(([n, e]) => chip(n, e))}</ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function Stages({ t }: { t: LandingCopy }) {
  return (
    <section className="px-6 py-28" aria-labelledby="stages-title">
      <div className="mx-auto max-w-6xl">
        <h2 id="stages-title" className={h2}>
          {t.stages.title}
        </h2>
        <p className="mt-4 text-base text-body">{t.stages.lead}</p>
        <ol className="mt-10 grid gap-x-8 border-t border-rule-strong sm:grid-cols-5">
          {STATUSES.map((s, i) => (
            <li key={s.id} className="flex items-baseline gap-3 border-b border-rule py-4 sm:block sm:border-b-0 sm:py-6">
              <span className="font-mono text-xs text-body">0{i + 1}</span>
              <div className="sm:mt-3">
                <div className="flex items-center gap-2 font-display text-2xl uppercase text-cream">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
                  {t.stages.names[s.id] ?? s.label}
                </div>
                <div className="mt-1 text-sm text-body">{t.stages.lines[s.id]}</div>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Points({ items }: { items: string[] }) {
  return (
    <ul className="mt-6 flex flex-col gap-2.5">
      {items.map((p) => (
        <li key={p} className="flex gap-3 text-sm leading-relaxed text-cream">
          <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-hot" aria-hidden /> {p}
        </li>
      ))}
    </ul>
  );
}

function Feature({ n, copy, shot, t, flip = false }: { n: string; copy: LandingCopy["library"]; shot: string; t: LandingCopy; flip?: boolean }) {
  return (
    <section className="scroll-mt-20 px-6 py-20" aria-labelledby={`f-${n}`}>
      <div className={`mx-auto grid max-w-6xl items-center gap-12 ${flip ? "md:grid-cols-[1.25fr_0.75fr] md:[&>*:first-child]:order-2" : "md:grid-cols-[0.8fr_1.2fr]"}`}>
        <div>
          <p className={kicker}>
            {n} / {copy.name}
          </p>
          <h2 id={`f-${n}`} className="mt-4 font-display text-4xl uppercase leading-[0.95] text-cream md:text-5xl">
            {copy.title}
          </h2>
          <p className="mt-5 text-base leading-relaxed text-body">{copy.body}</p>
          <Points items={copy.points} />
        </div>
        <Shot name={shot} alt={copy.alt} caption={copy.caption} fullSize={t.shot.fullSize} />
      </div>
    </section>
  );
}

function LaunchKit({ t }: { t: LandingCopy }) {
  return (
    <section id="launch-kit" className="scroll-mt-20 px-6 py-20" aria-labelledby="f-03">
      <div className="mx-auto max-w-6xl">
        <p className={kicker}>03 / {t.kit.name}</p>
        <div className="mt-4 grid gap-10 md:grid-cols-[1fr_1fr] md:items-end">
          <h2 id="f-03" className="font-display text-4xl uppercase leading-[0.95] text-cream md:text-6xl">
            {t.kit.title}
          </h2>
          <p className="text-base leading-relaxed text-body">{t.kit.lead}</p>
        </div>
        <div className="mt-12">
          <Shot name="launch-kit" caption={t.kit.caption} alt={t.kit.alt} fullSize={t.shot.fullSize} />
        </div>
        <dl className="mt-12 grid gap-px overflow-hidden rounded-md border border-rule bg-rule sm:grid-cols-2 lg:grid-cols-3">
          {t.kit.parts.map(([title, d]) => (
            <div key={title} className="bg-chassis p-5">
              <dt className="font-display text-xl uppercase text-cream">{title}</dt>
              <dd className="mt-2 text-sm leading-relaxed text-body">{d}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 max-w-3xl text-sm leading-relaxed text-body">
          <span className="text-cream">{t.kit.aiTitle}</span> {t.kit.aiBody}
        </p>
      </div>
    </section>
  );
}

function Crew({ t }: { t: LandingCopy }) {
  return (
    <section id="crew" className="scroll-mt-20 px-6 py-20" aria-labelledby="f-04">
      <div className="mx-auto max-w-6xl">
        <p className={kicker}>04 / {t.crew.name}</p>
        <h2 id="f-04" className={`mt-4 ${h2}`}>
          {t.crew.title}
        </h2>
        <div className="mt-10 grid gap-8 sm:grid-cols-2">
          {t.crew.items.map(([title, d]) => (
            <div key={title} className="border-t border-rule-strong pt-5">
              <h3 className="font-display text-2xl uppercase text-cream">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-body">{d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Privacy({ t }: { t: LandingCopy }) {
  return (
    <section id="privacy" className="scroll-mt-20 px-6 py-24" aria-labelledby="privacy-title">
      <div className="mx-auto max-w-6xl rounded-2xl bg-cream p-8 text-chassis md:p-14">
        <h2 id="privacy-title" className="font-display text-5xl uppercase leading-[0.95] md:text-7xl">
          {t.privacy.title}
        </h2>
        <p className="mt-5 max-w-2xl text-lg">{t.privacy.lead}</p>
        <div className="mt-10 grid gap-8 font-mono text-sm md:grid-cols-2">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-chassis/80">{t.privacy.travels}</h3>
            <ul className="mt-3 flex flex-col gap-1.5">
              {t.privacy.travelItems.map((x) => (
                <li key={x} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[#1f8a4c]" aria-hidden /> {x}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-chassis/80">{t.privacy.stays}</h3>
            <ul className="mt-3 flex flex-col gap-1.5 text-chassis/80">
              {t.privacy.stayItems.map((x) => (
                <li key={x} className="line-through decoration-chassis/40">
                  {x}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p className="mt-10 max-w-2xl font-mono text-xs leading-relaxed text-chassis/80">{t.privacy.note}</p>
      </div>
    </section>
  );
}

function Status({ t, version }: { t: LandingCopy; version: string | null }) {
  const s = t.status;
  const col = (title: string, items: string[], icon: ReactNode) => (
    <div className="rounded-md border border-rule bg-panel p-6">
      <h3 className="font-mono text-xs uppercase tracking-wider text-cream">{title}</h3>
      <ul className="mt-4 flex flex-col gap-3">
        {items.map((i) => (
          <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-body">
            <span className="mt-0.5 shrink-0">{icon}</span>
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <section id="status" className="scroll-mt-20 px-6 py-20" aria-labelledby="status-title">
      <div className="mx-auto max-w-6xl">
        <p className={kicker}>{version ? `${s.version.replace("{version}", version)} · ${s.date}` : s.date}</p>
        <h2 id="status-title" className={`mt-4 ${h2}`}>
          {s.title}
        </h2>
        <p className="mt-4 max-w-2xl text-base text-body">{s.lead}</p>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {col(s.ready, s.readyItems, <Check size={15} className="text-ok" aria-label={s.labels[0]} />)}
          {col(s.limits, s.limitItems, <Minus size={15} className="text-warn" aria-label={s.labels[1]} />)}
          {col(s.next, s.nextItems, <ArrowRight size={15} className="text-engrave" aria-label={s.labels[2]} />)}
        </div>
      </div>
    </section>
  );
}

function Faq({ t }: { t: LandingCopy }) {
  return (
    <section id="faq" className="scroll-mt-20 px-6 py-20" aria-labelledby="faq-title">
      <div className="mx-auto max-w-3xl">
        <h2 id="faq-title" className={h2}>
          {t.faq.title}
        </h2>
        <div className="mt-10 border-t border-rule-strong">
          {t.faq.items.map(([q, a]) => (
            <details key={q} className="group border-b border-rule">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 font-display text-xl uppercase text-cream marker:hidden hover:text-hot focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream">
                {q}
                <span className="font-mono text-lg text-engrave transition-transform group-open:rotate-45" aria-hidden>
                  +
                </span>
              </summary>
              <p className="pb-5 text-sm leading-relaxed text-body">{a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function Footer({ t, lang, version }: { t: LandingCopy; lang: Lang; version: string | null }) {
  return (
    <footer className="border-t border-rule px-6 py-10 text-xs text-body">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
        <span className="flex items-center gap-2">
          <LogoMark size={20} /> {version ? `Hivo ${version}` : "Hivo"} · {t.footer.tagline}
        </span>
        <nav aria-label={t.footer.nav} className="flex gap-4">
          <a href="#privacy" className="hover:text-cream">
            {t.nav.privacy}
          </a>
          <a href="#status" className="hover:text-cream">
            {t.nav.status}
          </a>
          <a href="#faq" className="hover:text-cream">
            {t.nav.faq}
          </a>
          <a href={`/${lang}/privacy`} className="hover:text-cream">
            {t.footer.privacyPolicy}
          </a>
        </nav>
        <span className="font-mono">{t.footer.data}</span>
      </div>
    </footer>
  );
}
