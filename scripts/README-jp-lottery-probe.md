# JP Official Lottery Data Probe

Minimal PoC to fetch **Loto 6**, **Mini Loto**, and **Loto 7** historical draws from Mizuho Bank official pages.

## Setup

```bash
pip install -r scripts/requirements-probe.txt
python -m playwright install chromium
```

## Run

```bash
python scripts/probe_jp_official_lottery_data.py
```

Outputs:

- `tmp/jp-loto6-probe.json`
- `tmp/jp-mini-loto-probe.json`
- `tmp/jp-loto7-probe.json`

## Fetch method

| Layer | Detail |
| --- | --- |
| Engine | Playwright **Chromium headed** (`HEADLESS=0` default) |
| Anti-bot | Akamai blocks plain `fetch` / headless; warmup on official index, then in-page `fetch()` with cookies |
| Loto 6 (1–460) | HTML backnumber tables: `.../backnumber/loto6XXXX.html` (20 draws/page) |
| Loto 6 (461+) | Official detail CSV: `.../loto6/csv/A102XXXX.CSV` |
| Mini Loto (1–520) | HTML backnumber tables: `.../backnumber/lotoXXXX.html` |
| Mini Loto (521+) | Official detail CSV: `.../miniloto/csv/A101XXXX.CSV` |
| Loto 7 | Official detail CSV: `.../loto7/csv/A103XXXX.CSV` |

Direct HTTP (`urllib`, headless Playwright) returns **403 Access Denied** (Akamai / edgesuite.net).

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `HEADLESS` | `0` | Set `1` to try headless (usually blocked) |
| `REQUEST_DELAY_SEC` | `0.25` | Delay between requests |

## Productization

1. Scheduled job (weekly) with headed Chromium or allowlisted IP.
2. Incremental fetch from last known `drawId`.
3. Internal API for Flutter app; no scraping in the app.
4. Retry/backoff + alert on Access Denied spikes.
5. Validate draw count vs official index before publish.
