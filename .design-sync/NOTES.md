# Claude Design sync: notes

- **This repo is an app, not a published design system.** The synced library is `src/ui/` (the app's own presentational components, imported by every screen). `scripts/design-lib.mjs` packages it as `fl-manager-ui` in `.design-sync/lib/` (generated, git-ignored): `.d.ts` via the repo's `tsc`, an entry that re-exports `src/ui`, and the app's compiled Tailwind CSS as `styles.css`. Always run `cfg.buildCmd` (`npm run build && node scripts/design-lib.mjs`) before the converter: the stylesheet comes from `dist/assets/index-*.css`.
- Run the converter from the repo root with `--node-modules ./node_modules` (no `--entry` flag needed: `cfg.entry` points at `.design-sync/lib/index.ts`).
- **Dark surface:** components are light-on-chassis (#0D0D0C) and invisible without a dark background. `Theme` (src/ui/base.tsx) is the provider (`cfg.provider`, `padded: true`) and the documented wrapper for designs.
- **Fonts (System 02):** Barlow Condensed (display), IBM Plex Sans/Mono and Oswald 600 (the Hivo wordmark) are bundled via @fontsource. Vite writes their `@font-face` urls as `/assets/<file>.woff2`, which would dangle in the sync, so `scripts/design-lib.mjs` copies every font file from `dist/assets/` next to `.design-sync/lib/styles.css` and rewrites the urls to `./<file>`; the converter then ships them under `fonts/` (84 files). No `extraFonts` needed.
- Font stacks must not name families the app doesn't ship: `"Arial Narrow"` (a fallback in `--font-display`) triggered `[FONT_MISSING]` and was removed from `src/theme.css`.
- **Tailwind:** only classes the app already uses exist in `styles.css` (Tailwind v4 generates on demand). New layouts in Claude Design should reuse the vocabulary in `conventions.md`.
- `dtsPropsFor` hand-writes the props for `StatusSelect`, `CheckLine`, `AiLine`, `MixdownBadge` and `FieldRow`: their real types live in `src/types.ts` / `src/lib/launchKit.ts`, which the per-component `.d.ts` can't reference.
- **Modal preview** wraps the fixed overlay in a `transform: translateZ(0)` box so it renders inside its card (`cardMode: single`, viewport 720x460).
- Playwright for the render check: install `playwright@1.63.0` in `.ds-sync/` (pins chromium-1243, which is cached on this machine).

- `Wordmark` uses `cardMode: column` (its Sizes story is wider than a grid cell: `[GRID_OVERFLOW]`).
- Previews for `LogoMark`, `Wordmark` and `SourceBadge` were authored in the Hivo/System 02 re-sync (2026-10-13); every card was re-graded or spot-checked against System 02 then.

## Re-sync without the converter (2026-11-02)

The design system is now the claude.ai artifact named in CLAUDE.md, and a small change can be synced file by file with the Artifact tool:

1. `npm run build && node scripts/design-lib.mjs`, then `npx vite build --config scripts/design-bundle.config.mjs`.
2. `components/bundle.js` = the artifact's first line (`/* @ds-bundle: … */`) + `.design-sync/lib/bundle-out/bundle.js`; `components/bundle.css` = `.design-sync/lib/styles.css` with `url(./<font>)` rewritten to `url(../fonts/<font>)`. The fonts only need re-uploading when their hashed names change.
3. Update the changed components' `README.md` / `.d.ts`, `components/index.d.ts`, the README's "Synced from" line and `tokens.json` `meta`; never `tokens.css` unless a token changed.
4. Publish only the changed `project/` files, with `project/design-system.json` (its `lastChange`) in the same, last call.

The previews (`preview.html`) embed their own compiled stories and still come from the converter; they keep working with a new bundle as long as the exports keep their names.

## Known render warns

- None (as of the 2026-10-13 re-sync).

## Re-sync risks

- `styles.css` is the app's compiled CSS: classes added or removed in the app change what designs can use. Re-run the build before every sync.
- `dtsPropsFor` copies the shapes of `KitField`, `AiFieldReview`, `Check` and `SongStatus`. If those types change in `src/`, update the config or the `.d.ts` the design agent sees will be wrong.
- Stage colors in `conventions.md` and `StatusDot.tsx` preview are copied from `src/lib/songs.ts` (`STATUSES`).
- System 02 tokens (`src/theme.css`) and the classes named in `conventions.md` must exist in the compiled CSS: Tailwind v4 only emits classes the app uses, so a token like `ok` has no `text-ok` class until some screen uses it. Re-validate the header's names after style changes.
- A restyle that keeps preview `.tsx` files unchanged still carries old grades forward (grades follow sources): after a visual overhaul, spot-check with `package-capture.mjs --spot-check-components`.
- The screen components (Dashboard, LaunchKitView…) are not synced: they read app stores. Only `src/ui` is.
