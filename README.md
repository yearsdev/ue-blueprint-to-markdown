# UE Blueprint → Markdown

**Live:** https://uetomd.yearsdev.com

Paste Unreal Engine Blueprint copy/paste text (or a material graph), get an
annotated ASCII flow diagram plus a documentation-ready markdown export.

Fully client-side: no backend, no storage, no auth. Paste in, copy or download
out. The whole thing builds to static files you can host anywhere.

## What it does

- Detects whether a paste is a Blueprint event graph or a material graph and
  runs the matching engine.
- Renders an annotated ASCII flow / expression diagram.
- Generates a markdown export (function signature, calls, variable references,
  review notes) ready to drop into docs.
- Toggle data pins on the diagram; optionally embed the raw paste in the `.md`.
- Copy ASCII / copy markdown / download `.txt` / download `.md`.

## Usage

In the UE Blueprint editor, select the nodes you want, right-click > Copy, then
paste into the left pane. The diagram renders live on the right; switch to the
Markdown tab for the export.

## Develop

```
npm install
npm run dev      # Vite dev server with hot reload
npm test         # run the engine test suite (vitest)
npm run build    # static production build -> dist/
npm run preview  # serve the production build locally
```

## Deploy

`npm run build` emits a self-contained `dist/`. Host it as static files —
Cloudflare Pages, GitHub Pages, Netlify, an S3/Spaces bucket, etc. No server
component is required. The Vite `base` is relative, so it works from a subpath
(e.g. GitHub project pages) without extra config.

This repo deploys to Cloudflare ([uetomd.yearsdev.com](https://uetomd.yearsdev.com))
via the Git integration: every push to `main` builds with `npm run build` and
serves `dist/` (config in `wrangler.jsonc`). Note `package-lock.json` is
intentionally untracked — see `.gitignore` for why.

## Engine

The parse/render/export engine lives in `src/blueprint/*` and `src/material/*`,
fronted by the `src/blueprintEngine.js` / `src/materialEngine.js` barrels. It is
pure JS with no UI or storage dependencies, carried over verbatim from the
Banishment content editor where it originated. Tests in `src/__tests__/` cover
both pipelines.
