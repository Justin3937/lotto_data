# Lotto Data GitHub Pages

Public GitHub Pages fallback for app-facing lottery data.

## Scope

- Markets: Hong Kong, Japan, and United States
- HK Mark Six combines current official HKJC data with public fallback history.
- JP/US normally prefer official sources and can use unofficial backup sources.
- JP/US backup draws remain marked `unofficial_backup_unverified` and must not
  be promoted to official data. Set `LOTTO_DISABLE_OFFICIAL_FETCH=1` only for
  an explicit fallback test.

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

The workflow is scheduled at minute 17 of every hour to avoid GitHub Actions
top-of-hour congestion. It runs only around configured post-draw windows, with
a bounded six-hour catch-up period after the final regular polling window so a
delayed GitHub schedule can still publish the draw.
