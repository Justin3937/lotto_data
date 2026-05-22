# Lotto Data GitHub Pages

Public GitHub Pages mirror for official lottery data.

## Scope

- Market: Hong Kong
- Game: Mark Six
- Source: HKJC official GraphQL endpoint only
- Fallback sources are intentionally excluded from this public repo

## Local Generate

```powershell
npm install
npm run generate
```

Generated data is written to `public/data/`. The human verification page is
`public/index.html`.

## GitHub Setup

1. Create a new public GitHub repository.
2. Copy this folder's contents to that repository root.
3. Enable GitHub Pages with GitHub Actions as the source.
4. Run the `Update lottery data and publish Pages` workflow manually once.

The workflow refreshes official data daily and publishes the static site.
