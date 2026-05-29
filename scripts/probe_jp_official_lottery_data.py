#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PoC: fetch JP Loto 6, Mini Loto, and Loto 7 historical draws from Mizuho Bank official pages.

Usage:
  pip install -r scripts/requirements-probe.txt
  python -m playwright install chromium
  python scripts/probe_jp_official_lottery_data.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
TMP_DIR = ROOT / "tmp"
SOURCE_NAME = "Mizuho Bank"
HEADLESS = os.environ.get("HEADLESS", "0") == "1"
REQUEST_DELAY_SEC = float(os.environ.get("REQUEST_DELAY_SEC", "0.25"))
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

ERAS = {
    "昭和": 1925,
    "平成": 1988,
    "令和": 2018,
}


@dataclass
class FetchReport:
    method: str
    successful_urls: list[str] = field(default_factory=list)
    failed_urls: list[dict[str, str]] = field(default_factory=list)
    access_denied_count: int = 0
    akamai_blocked: bool = False

    def record_ok(self, url: str) -> None:
        self.successful_urls.append(url)

    def record_fail(self, url: str, reason: str, access_denied: bool = False) -> None:
        self.failed_urls.append({"url": url, "reason": reason})
        if access_denied:
            self.access_denied_count += 1
            self.akamai_blocked = True


@dataclass
class GameConfig:
    game_id: str
    main_count: int
    special_count: int
    warmup_url: str
    csv_url_tpl: str | None
    csv_start: int
    html_url_tpl: str
    html_start: int
    html_end: int
    html_step: int
    detail_url_tpl: str | None
    latest_guess: int


LOTO6 = GameConfig(
    game_id="loto6_jp",
    main_count=6,
    special_count=1,
    warmup_url="https://www.mizuhobank.co.jp/takarakuji/check/loto/loto6/index.html",
    csv_url_tpl="https://www.mizuhobank.co.jp/retail/takarakuji/loto/loto6/csv/A102{n:04d}.CSV",
    csv_start=461,
    html_url_tpl="https://www.mizuhobank.co.jp/takarakuji/check/loto/backnumber/loto6{start:04d}.html",
    html_start=1,
    html_end=460,
    html_step=20,
    detail_url_tpl=None,
    latest_guess=2105,
)

MINI_LOTO = GameConfig(
    game_id="mini_loto",
    main_count=5,
    special_count=1,
    warmup_url="https://www.mizuhobank.co.jp/takarakuji/check/loto/miniloto/index.html",
    csv_url_tpl="https://www.mizuhobank.co.jp/retail/takarakuji/loto/miniloto/csv/A101{n:04d}.CSV",
    csv_start=521,
    html_url_tpl="https://www.mizuhobank.co.jp/takarakuji/check/loto/backnumber/loto{start:04d}.html",
    html_start=1,
    html_end=520,
    html_step=20,
    detail_url_tpl=None,
    latest_guess=1400,
)

LOTO7 = GameConfig(
    game_id="loto7_jp",
    main_count=7,
    special_count=2,
    warmup_url="https://www.mizuhobank.co.jp/takarakuji/check/loto/loto7/index.html",
    csv_url_tpl=None,
    csv_start=0,
    html_url_tpl="https://www.mizuhobank.co.jp/takarakuji/check/loto/backnumber/detail.html?fromto={start}_{end}&type=loto7",
    html_start=1,
    html_end=700,
    html_step=20,
    detail_url_tpl=None,
    latest_guess=700,
)


def parse_jp_date(raw: str) -> str | None:
    raw = raw.strip()
    m = re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", raw)
    if m:
        y, mo, d = map(int, m.groups())
        return f"{y:04d}-{mo:02d}-{d:02d}"

    m = re.search(r"(昭和|平成|令和)(\d+)年(\d+)月(\d+)日", raw)
    if m:
        era, ey, mo, d = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
        y = ERAS[era] + ey
        return f"{y:04d}-{mo:02d}-{d:02d}"
    return None


def draw_id_from_label(label: str) -> str | None:
    m = re.search(r"(\d+)", label)
    return m.group(1) if m else None


def fetch_bytes(page: Page, url: str) -> tuple[int, bytes]:
    payload = page.evaluate(
        """async (url) => {
          const res = await fetch(url, { credentials: "include" });
          const buf = await res.arrayBuffer();
          return { status: res.status, bytes: Array.from(new Uint8Array(buf)) };
        }""",
        url,
    )
    return payload["status"], bytes(payload["bytes"])


def fetch_text(page: Page, url: str, retries: int = 2) -> tuple[int, str]:
    last_status = 0
    for attempt in range(retries):
        status, raw = fetch_bytes(page, url)
        last_status = status
        if status != 200:
            time.sleep(REQUEST_DELAY_SEC)
            continue
        for enc in ("cp932", "shift_jis", "utf-8"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                text = raw.decode("cp932", errors="replace")
        if not is_access_denied(status, text):
            return status, text
        time.sleep(REQUEST_DELAY_SEC * 2)
    return last_status, ""


def fetch_rendered_html(page: Page, url: str) -> tuple[int, str]:
    response = page.goto(url, wait_until="networkidle", timeout=120_000)
    status = response.status if response else 0
    if status != 200:
        return status, ""
    return status, page.content()


def is_access_denied(status: int, text: str) -> bool:
    return status == 403 or "Access Denied" in text or "edgesuite.net" in text


def parse_csv_draw(
    text: str,
    main_count: int,
    special_count: int,
    source_url: str,
) -> dict[str, Any] | None:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if not lines:
        return None

    header_line = next((ln for ln in lines if "第" in ln and "回" in ln), None)
    if not header_line:
        return None

    draw_id_raw = draw_id_from_label(header_line)
    if not draw_id_raw:
        return None
    draw_id = str(int(draw_id_raw))

    draw_date = None
    for token in re.findall(r"[^,]+", header_line):
        parsed = parse_jp_date(token)
        if parsed:
            draw_date = parsed
            break

    main_numbers: list[int] = []
    special_numbers: list[int] = []
    for line in lines:
        if line.startswith("本数字,"):
            parts = line.split(",")
            if "ボーナス数字" in parts:
                idx = parts.index("ボーナス数字")
                main_numbers = [int(x) for x in parts[1:idx] if x.isdigit()]
                special_numbers = [
                    int(x)
                    for x in parts[idx + 1 : idx + 1 + special_count]
                    if x.isdigit()
                ]
            else:
                nums = [int(x) for x in parts[1:] if x.isdigit()]
                main_numbers = nums[:main_count]
                special_numbers = nums[main_count : main_count + special_count]

    if (
        not draw_date
        or len(main_numbers) != main_count
        or len(special_numbers) != special_count
    ):
        return None

    return {
        "drawId": draw_id,
        "drawDate": draw_date,
        "numbers": main_numbers,
        "specialNumber": special_numbers[0],
        "specialNumbers": special_numbers,
        "source": "official",
        "_sourceUrl": source_url,
    }


def parse_html_draws(
    html: str,
    main_count: int,
    special_count: int,
    source_url: str,
) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    draws: list[dict[str, Any]] = []
    for table in soup.find_all("table"):
        for tr in table.find_all("tr"):
            cells = [c.get_text(strip=True) for c in tr.find_all(["th", "td"])]
            if len(cells) < 2 + main_count + special_count:
                continue
            if cells[0] in ("回別", "回"):
                continue

            draw_id = draw_id_from_label(cells[0])
            draw_date = parse_jp_date(cells[1])
            if not draw_id or not draw_date:
                continue
            draw_id = str(int(draw_id))

            nums = [
                int(x)
                for x in cells[2 : 2 + main_count + special_count]
                if x.isdigit()
            ]
            if len(nums) != main_count + special_count:
                continue
            special_numbers = nums[main_count : main_count + special_count]

            draws.append(
                {
                    "drawId": draw_id,
                    "drawDate": draw_date,
                    "numbers": nums[:main_count],
                    "specialNumber": special_numbers[0],
                    "specialNumbers": special_numbers,
                    "source": "official",
                    "_sourceUrl": source_url,
                }
            )
    return draws


def find_latest_csv_draw(page: Page, cfg: GameConfig, report: FetchReport) -> int:
    if cfg.csv_url_tpl is None:
        return cfg.csv_start - 1

    n = cfg.latest_guess
    while n >= cfg.csv_start:
        url = cfg.csv_url_tpl.format(n=n)
        status, text = fetch_text(page, url)
        time.sleep(REQUEST_DELAY_SEC)
        if status == 200 and not is_access_denied(status, text):
            break
        if status not in (404, 403):
            report.record_fail(url, f"status={status}", access_denied=is_access_denied(status, text))
        n -= 1
    else:
        return cfg.csv_start - 1

    latest = n
    while True:
        url = cfg.csv_url_tpl.format(n=latest + 1)
        status, text = fetch_text(page, url)
        time.sleep(REQUEST_DELAY_SEC)
        if status == 200 and not is_access_denied(status, text):
            report.record_ok(url)
            latest += 1
            continue
        if status != 404:
            report.record_fail(url, f"status={status}", access_denied=is_access_denied(status, text))
        break
    return latest


def collect_game(page: Page, cfg: GameConfig, report: FetchReport) -> list[dict[str, Any]]:
    draws: list[dict[str, Any]] = []

    # HTML backnumber pages (older draws)
    html_starts = list(range(cfg.html_start, cfg.html_end + 1, cfg.html_step))
    for i, start in enumerate(html_starts, 1):
        url = cfg.html_url_tpl.format(start=start)
        status, text = fetch_text(page, url)
        time.sleep(REQUEST_DELAY_SEC)
        if status != 200 or is_access_denied(status, text):
            report.record_fail(
                url,
                f"status={status}",
                access_denied=is_access_denied(status, text),
            )
            continue

        parsed = parse_html_draws(text, cfg.main_count, cfg.special_count, url)
        if not parsed:
            report.record_fail(url, "parse_failed")
            continue

        report.record_ok(url)
        draws.extend(parsed)
        if i % 5 == 0 or i == len(html_starts):
            print(f"  [{cfg.game_id}] HTML pages {i}/{len(html_starts)}", flush=True)

    # Current detail pages cover some ranges where old static pages are gone.
    if cfg.detail_url_tpl:
        for i, start in enumerate(html_starts, 1):
            end = start + cfg.html_step - 1
            url = cfg.detail_url_tpl.format(start=start, end=end)
            status, text = fetch_rendered_html(page, url)
            time.sleep(REQUEST_DELAY_SEC)
            if status != 200 or is_access_denied(status, text):
                report.record_fail(
                    url,
                    f"status={status}",
                    access_denied=is_access_denied(status, text),
                )
                continue

            parsed = parse_html_draws(text, cfg.main_count, cfg.special_count, url)
            if not parsed:
                report.record_fail(url, "parse_failed")
                continue

            report.record_ok(url)
            draws.extend(parsed)
            if i % 5 == 0 or i == len(html_starts):
                print(f"  [{cfg.game_id}] detail pages {i}/{len(html_starts)}", flush=True)

    if cfg.csv_url_tpl is not None:
        latest = find_latest_csv_draw(page, cfg, report)
        print(f"  [{cfg.game_id}] latest CSV draw: {latest}", flush=True)

        csv_total = latest - cfg.csv_start + 1
        for idx, n in enumerate(range(cfg.csv_start, latest + 1), 1):
            url = cfg.csv_url_tpl.format(n=n)
            status, text = fetch_text(page, url)
            time.sleep(REQUEST_DELAY_SEC)
            if status != 200 or is_access_denied(status, text):
                report.record_fail(
                    url,
                    f"status={status}",
                    access_denied=is_access_denied(status, text),
                )
                continue

            draw = parse_csv_draw(text, cfg.main_count, cfg.special_count, url)
            if not draw:
                report.record_fail(url, "parse_failed")
                continue

            report.record_ok(url)
            draws.append(draw)
            if idx % 100 == 0 or idx == csv_total:
                print(f"  [{cfg.game_id}] CSV {idx}/{csv_total}", flush=True)

    return dedupe_and_sort(draws)


def dedupe_and_sort(draws: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for draw in draws:
        by_id[draw["drawId"]] = draw
    sorted_draws = sorted(by_id.values(), key=lambda d: (d["drawDate"], int(d["drawId"])))
    for draw in sorted_draws:
        draw.pop("_sourceUrl", None)
    return sorted_draws


def build_output(cfg: GameConfig, draws: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "marketId": "JP",
        "gameId": cfg.game_id,
        "sourceName": SOURCE_NAME,
        "sourceUrl": cfg.warmup_url,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "draws": draws,
    }


def print_stats(label: str, draws: list[dict[str, Any]], failed_count: int) -> None:
    if not draws:
        print(f"[{label}] 0 draws, failed URLs: {failed_count}")
        return
    dates = [d["drawDate"] for d in draws]
    print(
        f"[{label}] count={len(draws)} earliest={min(dates)} latest={max(dates)} failed_urls={failed_count}"
    )


def print_report(report: FetchReport) -> None:
    print(f"\n=== Fetch report ({report.method}) ===")
    print(f"Successful URL count: {len(report.successful_urls)}")
    print(f"Failed URL count: {len(report.failed_urls)}")
    print(f"Access Denied count: {report.access_denied_count}")
    print(f"Akamai/WAF blocked: {'yes' if report.akamai_blocked else 'no'}")
    if report.failed_urls[:5]:
        print("Sample failures:")
        for item in report.failed_urls[:5]:
            print(f"  - {item['url']} :: {item['reason']}")


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    report = FetchReport(
        method=(
            "Playwright Chromium (headed) + in-page fetch() after warmup; "
            "HTML backnumber tables + official detail CSV"
        )
    )

    print("JP official lottery probe")
    print(f"- headless={HEADLESS} (Akamai blocks headless; default is headed)")
    print(f"- delay={REQUEST_DELAY_SEC}s between requests")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=HEADLESS,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = browser.new_context(user_agent=USER_AGENT, locale="ja-JP")
        context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined});"
        )
        page = context.new_page()

        page.goto(LOTO6.warmup_url, wait_until="domcontentloaded", timeout=120_000)
        time.sleep(1)
        status, text = fetch_text(page, LOTO6.warmup_url)
        if is_access_denied(status, text):
            report.record_fail(LOTO6.warmup_url, f"warmup status={status}", access_denied=True)
            print("Warmup blocked by Akamai. Try HEADLESS=0 or run on a residential network.")
            browser.close()
            return 1
        report.record_ok(LOTO6.warmup_url)

        loto6_draws = collect_game(page, LOTO6, report)

        # Switch context to Mini Loto index
        page.goto(MINI_LOTO.warmup_url, wait_until="domcontentloaded", timeout=120_000)
        time.sleep(1)
        report.record_ok(MINI_LOTO.warmup_url)

        mini_draws = collect_game(page, MINI_LOTO, report)

        # Switch context to Loto 7 index
        page.goto(LOTO7.warmup_url, wait_until="domcontentloaded", timeout=120_000)
        time.sleep(1)
        report.record_ok(LOTO7.warmup_url)

        loto7_draws = collect_game(page, LOTO7, report)
        browser.close()

    loto6_out = build_output(LOTO6, loto6_draws)
    mini_out = build_output(MINI_LOTO, mini_draws)
    loto7_out = build_output(LOTO7, loto7_draws)

    loto6_path = TMP_DIR / "jp-loto6-probe.json"
    mini_path = TMP_DIR / "jp-mini-loto-probe.json"
    loto7_path = TMP_DIR / "jp-loto7-probe.json"
    write_json(loto6_path, loto6_out)
    write_json(mini_path, mini_out)
    write_json(loto7_path, loto7_out)

    print("\n=== Results ===")
    print_stats("Loto 6", loto6_draws, len(report.failed_urls))
    print_stats("Mini Loto", mini_draws, len(report.failed_urls))
    print_stats("Loto 7", loto7_draws, len(report.failed_urls))
    print_report(report)

    print("\n=== Output files ===")
    print(loto6_path)
    print(mini_path)
    print(loto7_path)

    print("\n=== Productization next steps ===")
    print("1. Run as scheduled job (e.g. weekly) on a server with headed Chromium or approved IP.")
    print("2. Persist last fetched drawId; only pull new CSV + latest index page.")
    print("3. Wrap fetch layer behind an internal API; Flutter app reads JSON/API only.")
    print("4. Add retries/backoff for transient 403; alert if Access Denied spikes.")
    print("5. Validate draw count vs official index before publishing to app cache.")

    ok = len(loto6_draws) >= 100 and len(mini_draws) >= 100
    if not ok:
        print("\nWARNING: acceptance threshold not met (need >100 draws for Loto 6 and Mini Loto).")
        return 2
    if len(loto7_draws) < 100:
        print("\nWARNING: Loto 7 probe returned fewer than 100 draws; publishing continues with seed/fallback data.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
