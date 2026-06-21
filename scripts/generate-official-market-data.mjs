import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { duePolls } from './lottery-due-windows.mjs';

const SCHEMA_VERSION = 1;
const USER_AGENT = 'lotto-data-github-pages/0.2';
const HKJC_GRAPHQL_ENDPOINT = 'https://info.cld.hkjc.com/graphql/base/';
const MARK_SIX_HISTORY_FALLBACK_URL =
  'https://raw.githubusercontent.com/icelam/mark-six-data-visualization/master/data/all.json';
const POWERBALL_ENDPOINT =
  'https://data.ny.gov/resource/d6yy-54nr.json?$limit=50000&$order=draw_date';
const MEGA_MILLIONS_ENDPOINT =
  'https://data.ny.gov/resource/5xaw-6ayf.json?$limit=50000&$order=draw_date';
const POWERBALL_PREVIOUS_RESULTS_URL = 'https://www.powerball.com/previous-results';
const MIZUHO_BASE = 'https://www.mizuhobank.co.jp';
const SYUMIMANIA_BASE = 'https://takarakuji.syumimania.com';
const LOTTO_NET_BASE = 'https://www.lotto.net';
const FETCH_TIMEOUT_MS = 20000;
const UNOFFICIAL_BACKUP_ATTEMPTS = 3;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MONTH_NUMBERS = {
  January: '01',
  February: '02',
  March: '03',
  April: '04',
  May: '05',
  June: '06',
  July: '07',
  August: '08',
  September: '09',
  October: '10',
  November: '11',
  December: '12',
};
const HKJC_MARK_SIX_QUERY = `
fragment lotteryDrawsFragment on LotteryDraw {
  id
  year
  no
  openDate
  closeDate
  drawDate
  status
  snowballCode
  snowballName_en
  snowballName_ch
  lotteryPool {
    sell
    status
    totalInvestment
    jackpot
    unitBet
    estimatedPrize
    derivedFirstPrizeDiv
    lotteryPrizes {
      type
      winningUnit
      dividend
    }
  }
  drawResult {
    drawnNo
    xDrawnNo
  }
}

query marksixResult($lastNDraw: Int, $startDate: String, $endDate: String, $drawType: LotteryDrawType) {
  lotteryDraws(lastNDraw: $lastNDraw, startDate: $startDate, endDate: $endDate, drawType: $drawType) {
    ...lotteryDrawsFragment
  }
}
`;

const root = resolve(import.meta.dirname, '..');
const publicDataDir = resolve(root, 'public', 'data');
const checkedAt = new Date().toISOString();

const games = [
  {
    marketId: 'HK',
    gameId: 'mark_six',
    pathMarket: 'hk',
    pathGame: 'mark-six',
    fetchOfficial: fetchOfficialMarkSix,
    fetchUnofficialBackup: fetchFallbackMarkSixHistory,
  },
  {
    marketId: 'JP',
    gameId: 'mini_loto',
    pathMarket: 'jp',
    pathGame: 'mini-loto',
    fetchOfficial: (seedDraws) =>
      fetchOfficialMizuhoLoto({
        probeFile: 'jp-mini-loto-probe.json',
        seedDraws,
        type: 'miniloto',
        currentPath: '/takarakuji/check/loto/miniloto/index.html',
        oldPrefix: 'loto',
        numberCount: 5,
      }),
    fetchUnofficialBackup: (seedDraws) =>
      fetchSyumimaniaMiniLotoBackup({ seedDraws, numberCount: 5, specialCount: 1 }),
  },
  {
    marketId: 'JP',
    gameId: 'loto6_jp',
    pathMarket: 'jp',
    pathGame: 'loto6',
    fetchOfficial: (seedDraws) =>
      fetchOfficialMizuhoLoto({
        probeFile: 'jp-loto6-probe.json',
        seedDraws,
        type: 'loto6',
        currentPath: '/takarakuji/check/loto/loto6/index.html',
        oldPrefix: 'loto6',
        numberCount: 6,
      }),
    fetchUnofficialBackup: (seedDraws) =>
      fetchSyumimaniaTableBackup({
        seedDraws,
        url: `${SYUMIMANIA_BASE}/loto6/`,
        gameNamePattern: 'ロト6',
        numberCount: 6,
        specialCount: 1,
      }),
  },
  {
    marketId: 'JP',
    gameId: 'loto7_jp',
    pathMarket: 'jp',
    pathGame: 'loto7',
    fetchOfficial: (seedDraws) =>
      fetchOfficialMizuhoLoto({
        probeFile: 'jp-loto7-probe.json',
        seedDraws,
        type: 'loto7',
        currentPath: '/takarakuji/check/loto/loto7/index.html',
        oldPrefix: 'loto7',
        numberCount: 7,
        specialCount: 2,
        csv: {
          type: 'loto7',
          prefix: 'A103',
          start: 1,
        },
      }),
    fetchUnofficialBackup: (seedDraws) =>
      fetchSyumimaniaTableBackup({
        seedDraws,
        url: `${SYUMIMANIA_BASE}/loto7/`,
        gameNamePattern: 'ロト7',
        numberCount: 7,
        specialCount: 2,
      }),
  },
  {
    marketId: 'US',
    gameId: 'powerball',
    pathMarket: 'us',
    pathGame: 'powerball',
    fetchOfficial: fetchOfficialPowerball,
    fetchUnofficialBackup: () =>
      fetchLottoNetBackup({
        url: `${LOTTO_NET_BASE}/powerball/numbers`,
        specialClass: 'powerball',
        numberCount: 5,
      }),
  },
  {
    marketId: 'US',
    gameId: 'mega_millions',
    pathMarket: 'us',
    pathGame: 'mega-millions',
    fetchOfficial: fetchOfficialMegaMillions,
    fetchUnofficialBackup: () =>
      fetchLottoNetBackup({
        url: `${LOTTO_NET_BASE}/mega-millions/numbers`,
        specialClass: 'mega-ball',
        numberCount: 5,
      }),
  },
  {
    marketId: 'US',
    gameId: 'lotto_america',
    pathMarket: 'us',
    pathGame: 'lotto-america',
    fetchOfficial: fetchOfficialLottoAmerica,
    fetchUnofficialBackup: () =>
      fetchLottoNetBackup({
        url: `${LOTTO_NET_BASE}/lotto-america/numbers`,
        specialClass: 'star-ball',
        numberCount: 5,
      }),
  },
];

const generated = [];
const dueWindowOnly = process.env.LOTTO_DUE_WINDOW_ONLY === '1';
const selectedGameIds = new Set(
  String(process.env.LOTTO_GAME_IDS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
const dueGameIds = new Set(duePolls(new Date(checkedAt)).map((entry) => entry.gameId));
const gamesToGenerate = games.filter((game) => {
  if (selectedGameIds.size > 0) return selectedGameIds.has(game.gameId);
  if (dueWindowOnly) return dueGameIds.has(game.gameId);
  return true;
});

if (gamesToGenerate.length === 0) {
  console.log('No lottery games are due for this scheduled window.');
}

for (const game of gamesToGenerate) {
  const seedDraws = await readSeedDraws(game);
  const officialState = await safeFetchOfficial(game, seedDraws);
  const unofficialState = await safeFetchUnofficialBackup(game, seedDraws);
  const draws = mergeDraws({
    seedDraws,
    unofficialDraws: unofficialState.draws,
    officialDraws: officialState.draws,
  });

  if (draws.length === 0) {
    throw new Error(`${game.marketId}/${game.gameId} has no seed or official draws`);
  }

  generated.push({
    game,
    draws,
    latestDraw: draws[draws.length - 1],
    verificationStatus: mergedVerificationStatus(draws, officialState, seedDraws),
    sourceSummary: {
      official: {
        ok: officialState.ok,
        drawCount: officialState.draws.length,
        error: officialState.error,
      },
      unofficialBackup: {
        ok: unofficialState.ok,
        drawCount: unofficialState.draws.length,
        error: unofficialState.error,
      },
      seed: {
        ok: seedDraws.length > 0,
        drawCount: seedDraws.length,
      },
      merged: {
        totalDrawCount: draws.length,
      },
    },
  });
}

const files =
  gamesToGenerate.length === 0
    ? []
    : gamesToGenerate.length === games.length
      ? buildIndexFile(generated)
      : [await buildMergedIndexFile(generated)];
for (const output of generated) {
  files.push(...buildGameFiles(output));
}

for (const file of files) {
  const path = resolve(publicDataDir, file.key);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, file.body, 'utf8');
  console.log(`Wrote data/${file.key}`);
}

async function safeFetchOfficial(game, seedDraws) {
  if (officialFetchDisabledFor(game)) {
    return {
      ok: false,
      draws: [],
      error: 'Official fetch disabled by LOTTO_DISABLE_OFFICIAL_FETCH',
    };
  }
  try {
    const draws = await game.fetchOfficial(seedDraws);
    return {
      ok: draws.length > 0,
      draws,
      error: draws.length > 0 ? null : 'Official source returned zero parsed draws',
    };
  } catch (error) {
    return {
      ok: false,
      draws: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function safeFetchUnofficialBackup(game, seedDraws) {
  if (typeof game.fetchUnofficialBackup !== 'function') {
    return {
      ok: false,
      draws: [],
      error: null,
    };
  }
  let lastError = 'Unofficial backup returned zero parsed draws';
  for (let attempt = 1; attempt <= UNOFFICIAL_BACKUP_ATTEMPTS; attempt += 1) {
    try {
      const draws = await game.fetchUnofficialBackup(seedDraws);
      if (draws.length > 0) {
        return {
          ok: true,
          draws,
          error: null,
        };
      }
      lastError = 'Unofficial backup returned zero parsed draws';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < UNOFFICIAL_BACKUP_ATTEMPTS) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 500));
    }
  }
  return {
    ok: false,
    draws: [],
    error: lastError,
  };
}

function officialFetchDisabledFor(game) {
  return process.env.LOTTO_DISABLE_OFFICIAL_FETCH === '1' &&
    (game.marketId === 'JP' || game.marketId === 'US');
}

async function fetchOfficialPowerball() {
  const rows = await fetchJson(POWERBALL_ENDPOINT);
  return rows
    .map((row) => {
      const drawDate = normalizeDrawDate(row.draw_date);
      const values = parseNumberList(row.winning_numbers);
      if (!drawDate || values.length < 6) return null;
      return officialDraw({
        drawId: drawDate,
        drawDate,
        numbers: values.slice(0, 5),
        specialNumber: values[5],
      });
    })
    .filter(Boolean);
}

async function fetchOfficialMegaMillions() {
  const rows = await fetchJson(MEGA_MILLIONS_ENDPOINT);
  return rows
    .map((row) => {
      const drawDate = normalizeDrawDate(row.draw_date);
      const numbers = parseNumberList(row.winning_numbers).slice(0, 5);
      const specialNumber = parseInteger(row.mega_ball);
      if (!drawDate || numbers.length !== 5 || specialNumber == null) return null;
      return officialDraw({
        drawId: drawDate,
        drawDate,
        numbers,
        specialNumber,
      });
    })
    .filter(Boolean);
}

async function fetchOfficialLottoAmerica() {
  const currentYear = new Date(checkedAt).getUTCFullYear();
  const draws = [];
  for (let year = 2017; year <= currentYear; year += 1) {
    draws.push(...(await fetchPowerballLottoAmericaYear(year)));
  }
  return draws;
}

async function fetchPowerballLottoAmericaYear(year) {
  const draws = [];
  let page = 1;
  let maxPage = 1;
  do {
    const url = new URL(POWERBALL_PREVIOUS_RESULTS_URL);
    url.searchParams.set('gc', 'lotto-america');
    url.searchParams.set('sd', `${year}-01-01`);
    url.searchParams.set('ed', `${year}-12-31`);
    url.searchParams.set('pg', String(page));
    const html = await fetchText(url.toString(), {
      headers: {
        'user-agent': BROWSER_USER_AGENT,
        'x-requested-with': 'XMLHttpRequest',
      },
    });
    draws.push(...parsePowerballLottoAmericaHtml(html));
    maxPage = Math.max(maxPage, parsePowerballResultsMaxPage(html));
    page += 1;
  } while (page <= maxPage);
  return draws;
}

async function fetchOfficialMarkSix() {
  const windows = defaultOfficialFetchWindows(new Date());
  const draws = [];
  for (const window of windows) {
    const payload = await fetchJson(HKJC_GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        accept: 'application/json,*/*',
        'content-type': 'application/json',
        origin: 'https://bet.hkjc.com',
        referer: 'https://bet.hkjc.com/marksix/?lang=en',
      },
      body: JSON.stringify({
        operationName: 'marksixResult',
        query: HKJC_MARK_SIX_QUERY,
        variables: {
          startDate: window.startDate,
          endDate: window.endDate,
          drawType: 'All',
        },
      }),
    });
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const message = payload.errors.map((error) => error.message ?? String(error)).join('; ');
      throw new Error(`HKJC GraphQL returned errors: ${message}`);
    }
    const records = Array.isArray(payload?.data?.lotteryDraws) ? payload.data.lotteryDraws : [];
    draws.push(
      ...records
        .map((record) => {
          const drawId = stringValue(record.id ?? record.no);
          const drawDate = normalizeDrawDate(record.drawDate ?? record.openDate);
          const numbers = parseNumberList(record.drawResult?.drawnNo).slice(0, 6);
          const specialNumber = parseInteger(record.drawResult?.xDrawnNo);
          if (!drawId || !drawDate || numbers.length !== 6 || specialNumber == null) return null;
          return officialDraw({ drawId, drawDate, numbers, specialNumber });
        })
        .filter(Boolean),
    );
  }
  return draws;
}

async function fetchFallbackMarkSixHistory() {
  const payload = await fetchJson(MARK_SIX_HISTORY_FALLBACK_URL, {
    headers: {
      'user-agent': USER_AGENT,
    },
  });
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.draws)
        ? payload.draws
        : [];
  return records.map(parseFallbackMarkSixRecord).filter(Boolean);
}

function parseFallbackMarkSixRecord(record) {
  const drawId = stringValue(record.id ?? record.drawId ?? record.drawNo);
  const drawDate = normalizeDrawDate(record.date ?? record.drawDate ?? record.openDate);
  const numbers = parseNumberList(record.no ?? record.numbers).slice(0, 6);
  const specialNumber = parseInteger(record.sno ?? record.special ?? record.specialNumber);
  if (!drawId || !drawDate || numbers.length !== 6 || specialNumber == null) return null;
  return {
    drawId,
    drawDate,
    numbers,
    specialNumber,
    status: 'fallback',
    verificationStatus: 'fallback',
  };
}

async function fetchOfficialMizuhoLoto({
  probeFile,
  seedDraws = [],
  type,
  currentPath,
  oldPrefix,
  numberCount,
  specialCount = 1,
  csv = null,
}) {
  const probeDraws = await readProbeDraws(probeFile, { numberCount, specialCount });
  if (isAtLeastAsFresh(probeDraws, seedDraws)) {
    return probeDraws;
  }

  if (csv) {
    const csvDraws = await fetchMizuhoCsvDraws({
      ...csv,
      numberCount,
      specialCount,
    });
    if (csvDraws.length > 0) {
      return csvDraws;
    }
  }

  const urls = new Set([new URL(currentPath, MIZUHO_BASE).toString()]);
  const indexUrl = new URL('/takarakuji/check/loto/backnumber/index.html', MIZUHO_BASE).toString();
  try {
    const indexHtml = await fetchText(indexUrl);
    for (const url of extractMizuhoLinks(indexHtml, type)) {
      urls.add(url);
    }
  } catch (_error) {
    // The backnumber index is commonly blocked by Akamai, but direct detail pages may still work.
  }

  if (urls.size <= 1) {
    for (const url of buildMizuhoFallbackUrls({ type, oldPrefix })) {
      urls.add(url);
    }
  }

  const draws = [];
  for (const url of urls) {
    const html = await fetchText(url);
    draws.push(...parseMizuhoLotoHtml(html, { numberCount, specialCount }));
  }
  return draws;
}

function isAtLeastAsFresh(candidateDraws, baselineDraws) {
  if (candidateDraws.length === 0) return false;
  const candidateLatest = latestDrawDate(candidateDraws);
  const baselineLatest = latestDrawDate(baselineDraws);
  return !baselineLatest || (!!candidateLatest && candidateLatest >= baselineLatest);
}

function latestDrawDate(draws) {
  return draws.reduce((latest, draw) => {
    const drawDate = normalizeDrawDate(draw.drawDate);
    return drawDate && (!latest || drawDate > latest) ? drawDate : latest;
  }, null);
}

async function fetchMizuhoCsvDraws({ type, prefix, start, numberCount, specialCount }) {
  const latest = await findMizuhoLatestCsvDraw({ type, prefix });
  const draws = [];
  const batchSize = 12;
  for (let batchStart = start; batchStart <= latest; batchStart += batchSize) {
    const batch = [];
    for (let n = batchStart; n < batchStart + batchSize && n <= latest; n += 1) {
      batch.push(fetchMizuhoCsvDraw({ type, prefix, n, numberCount, specialCount }));
    }
    draws.push(...(await Promise.all(batch)).filter(Boolean));
  }
  return draws;
}

async function findMizuhoLatestCsvDraw({ type, prefix }) {
  const text = await fetchText(`${MIZUHO_BASE}/takarakuji/apl/txt/${type}/name.txt`, {
    headers: {
      accept: 'text/plain,*/*',
      'user-agent': BROWSER_USER_AGENT,
    },
  });
  const pattern = new RegExp(`${prefix}(\\d{4})\\.CSV`, 'g');
  const drawIds = [...text.matchAll(pattern)].map((match) => Number.parseInt(match[1], 10));
  const latest = Math.max(...drawIds.filter(Number.isFinite));
  if (!Number.isFinite(latest)) {
    throw new Error(`Unable to find latest ${type} CSV draw from name.txt`);
  }
  return latest;
}

async function fetchMizuhoCsvDraw({ type, prefix, n, numberCount, specialCount }) {
  const url = `${MIZUHO_BASE}/retail/takarakuji/loto/${type}/csv/${prefix}${String(n).padStart(4, '0')}.CSV`;
  const text = await fetchShiftJisText(url, {
    headers: {
      'user-agent': BROWSER_USER_AGENT,
    },
  });
  return parseMizuhoCsvDraw(text, { numberCount, specialCount, sourceDrawId: n });
}

function parseMizuhoCsvDraw(text, { numberCount, specialCount, sourceDrawId }) {
  const rows = text
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s*,\s*/));
  const header = rows.find((row) => row[0]?.includes('回'));
  const numberRow = rows.find((row) => row[0] === '本数字');
  if (!header || !numberRow) return null;

  const drawId = drawIdFromJapaneseLabel(header[0]) ?? String(sourceDrawId);
  const drawDate = normalizeJapaneseDrawDate(header[2]);
  const numbers = numberRow.slice(1, 1 + numberCount).map(parseInteger).filter((item) => item != null);
  const specialNumbers = parseMizuhoSpecialNumbers(numberRow, { numberCount, specialCount });
  if (!drawId || !drawDate || numbers.length !== numberCount || specialNumbers.length !== specialCount) {
    return null;
  }
  return officialDraw({ drawId, drawDate, numbers, specialNumbers });
}

function parseMizuhoSpecialNumbers(numberRow, { numberCount, specialCount }) {
  const bonusIndex = numberRow.findIndex((item) => item.includes('ボーナス'));
  if (bonusIndex >= 0) {
    const specialNumbers = numberRow
      .slice(bonusIndex + 1, bonusIndex + 1 + specialCount)
      .map(parseInteger)
      .filter((item) => item != null);
    if (specialNumbers.length === specialCount) return specialNumbers;
  }

  const parenthesized = numberRow
    .flatMap((item) => [...String(item ?? '').matchAll(/\(\s*(\d{1,2})\s*\)/g)])
    .map((match) => Number.parseInt(match[1], 10))
    .filter(Number.isFinite);
  if (parenthesized.length >= specialCount) return parenthesized.slice(0, specialCount);

  return numberRow
    .slice(1 + numberCount, 1 + numberCount + specialCount)
    .map((item) => parseInteger(String(item ?? '').replace(/[()]/g, '')))
    .filter((item) => item != null);
}

function drawIdFromJapaneseLabel(value) {
  const match = String(value ?? '').match(/(\d+)/);
  return match ? String(Number.parseInt(match[1], 10)) : null;
}

async function readProbeDraws(probeFile, { numberCount, specialCount = 1 }) {
  if (!probeFile) return [];
  const path = resolve(root, 'tmp', probeFile);
  let payload;
  try {
    payload = JSON.parse(await readFile(path, 'utf8'));
  } catch (_error) {
    return [];
  }

  const draws = Array.isArray(payload.draws) ? payload.draws : [];
  return draws
    .map((draw) => {
      const drawId = stringValue(draw.drawId);
      const drawDate = normalizeDrawDate(draw.drawDate);
      const numbers = Array.isArray(draw.numbers)
        ? draw.numbers.map(parseInteger).filter((value) => value != null)
        : [];
      const specialNumbers = parseSpecialNumbers(draw, specialCount);
      if (!drawId || !drawDate || numbers.length !== numberCount || specialNumbers.length !== specialCount) {
        return null;
      }
      return officialDraw({ drawId, drawDate, numbers, specialNumbers });
    })
    .filter(Boolean);
}

function extractMizuhoLinks(html, type) {
  const links = new Set();
  const hrefPattern = /href=["']([^"']+)["']/gi;
  let match;
  while ((match = hrefPattern.exec(html)) != null) {
    const href = decodeHtml(match[1]);
    const normalized = new URL(href, MIZUHO_BASE).toString();
    if (
      normalized.includes(`/check/loto/backnumber/detail.html`) &&
      normalized.includes(`type=${type}`)
    ) {
      links.add(normalized);
    }
    if (
      type === 'loto6' &&
      /\/(?:check\/)?loto\/backnumber\/loto6\d+\.html$/.test(new URL(normalized).pathname)
    ) {
      links.add(normalized);
    }
    if (
      type === 'miniloto' &&
      /\/(?:check\/)?loto\/backnumber\/loto\d+\.html$/.test(new URL(normalized).pathname)
    ) {
      links.add(normalized);
    }
  }
  return links;
}

function buildMizuhoFallbackUrls({ type, oldPrefix }) {
  const urls = [];
  const estimatedLatest = type === 'loto6' ? 2100 : type === 'loto7' ? 700 : 1400;
  for (let start = 1; start <= estimatedLatest; start += 20) {
    const end = start + 19;
    urls.push(
      new URL(
        `/takarakuji/check/loto/backnumber/detail.html?fromto=${start}_${end}&type=${type}`,
        MIZUHO_BASE,
      ).toString(),
    );
    urls.push(
      new URL(
        `/takarakuji/loto/backnumber/${oldPrefix}${String(start).padStart(4, '0')}.html`,
        MIZUHO_BASE,
      ).toString(),
    );
  }
  return urls;
}

function parseMizuhoLotoHtml(html, { numberCount, specialCount = 1 }) {
  const text = normalizeJapaneseText(stripHtml(html));
  const draws = [];
  const pattern = /第\s*(\d+)\s*回\s+(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^0-9]{0,40}((?:\d{1,2}\s+){5,9})/g;
  let match;
  while ((match = pattern.exec(text)) != null) {
    const allNumbers = parseNumberList(match[5]);
    if (allNumbers.length < numberCount + specialCount) continue;
    const numbers = allNumbers.slice(0, numberCount);
    const specialNumbers = allNumbers.slice(numberCount, numberCount + specialCount);
    draws.push(
      officialDraw({
        drawId: match[1],
        drawDate: `${match[2]}-${match[3].padStart(2, '0')}-${match[4].padStart(2, '0')}`,
        numbers,
        specialNumbers,
      }),
    );
  }
  return draws;
}

function parsePowerballLottoAmericaHtml(html) {
  const draws = [];
  const cardPattern =
    /<a class="card"[^>]*[?&](?:amp;)?date=(\d{4}-\d{2}-\d{2})[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = cardPattern.exec(html)) != null) {
    const [, drawDate, cardHtml] = match;
    const values = [
      ...cardHtml.matchAll(
        /<div class="[^"]*\bitem-lotto-america\b[^"]*">[\s\S]*?<div>\s*(\d{1,2})\s*<\/div>\s*<\/div>/g,
      ),
    ]
      .map((item) => Number.parseInt(item[1], 10))
      .filter((item) => Number.isFinite(item));
    if (values.length !== 6) continue;
    draws.push(
      officialDraw({
        drawId: drawDate,
        drawDate,
        numbers: values.slice(0, 5),
        specialNumber: values[5],
      }),
    );
  }
  return draws;
}

function parsePowerballResultsMaxPage(html) {
  const button = html.match(/<button[^>]*\bid=["']loadMore["'][^>]*>/i)?.[0];
  const value = button?.match(/\bdata-max=["'](\d+)["']/i)?.[1];
  return value ? Number.parseInt(value, 10) : 1;
}

async function fetchLottoNetBackup({ url, specialClass, numberCount }) {
  const html = await fetchText(url, {
    headers: {
      'user-agent': BROWSER_USER_AGENT,
    },
  });
  return parseLottoNetNumbersHtml(html, { specialClass, numberCount });
}

function parseLottoNetNumbersHtml(html, { specialClass, numberCount }) {
  const draws = [];
  const cardPattern =
    /<div class="(?:results-big|results-med)">([\s\S]*?)(?=<div class="(?:results-big|results-med|promo-box)"|<a name="previousResults"|$)/g;
  let match;
  while ((match = cardPattern.exec(html)) != null) {
    const cardHtml = match[1];
    const dateMatch = cardHtml.match(
      /<div class="date">\s*[A-Za-z]+\s*<span>(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})<\/span>/,
    );
    if (!dateMatch) continue;
    const [, day, monthName, year] = dateMatch;
    const month = MONTH_NUMBERS[monthName];
    if (!month) continue;

    const mainNumbers = [];
    const ballPattern = /<li class="ball ([^"]+)">\s*<span>(\d{1,2})<\/span>/g;
    let ballMatch;
    let specialNumber = null;
    while ((ballMatch = ballPattern.exec(cardHtml)) != null) {
      const classes = ballMatch[1].split(/\s+/);
      const value = Number.parseInt(ballMatch[2], 10);
      if (!Number.isFinite(value)) continue;
      if (classes.includes(specialClass)) {
        specialNumber = value;
      } else if (classes.includes('ball') && mainNumbers.length < numberCount) {
        mainNumbers.push(value);
      }
    }
    if (mainNumbers.length !== numberCount || specialNumber == null) continue;
    const drawDate = `${year}-${month}-${day.padStart(2, '0')}`;
    draws.push(
      unofficialBackupDraw({
        drawId: drawDate,
        drawDate,
        numbers: mainNumbers,
        specialNumber,
        sourceName: 'lotto.net',
      }),
    );
  }
  return draws;
}

async function fetchSyumimaniaMiniLotoBackup({ seedDraws, numberCount, specialCount }) {
  const categoryHtml = await fetchText(`${SYUMIMANIA_BASE}/category/miniloto/`, {
    headers: {
      'user-agent': BROWSER_USER_AGENT,
    },
  });
  const urls = [...categoryHtml.matchAll(/href="(https:\/\/takarakuji\.syumimania\.com\/miniloto-\d+\/)"/g)]
    .map((match) => match[1])
    .filter((url, index, list) => list.indexOf(url) === index)
    .slice(0, 8);
  const baseline = latestSeedBaseline(seedDraws);
  const draws = [];
  for (const url of urls) {
    const html = await fetchText(url, {
      headers: {
        'user-agent': BROWSER_USER_AGENT,
      },
    });
    draws.push(
      ...parseSyumimaniaTableHtml(html, {
        seedBaseline: baseline,
        gameNamePattern: 'ミニロト',
        numberCount,
        specialCount,
      }),
    );
  }
  return draws;
}

async function fetchSyumimaniaTableBackup({
  seedDraws,
  url,
  gameNamePattern,
  numberCount,
  specialCount,
}) {
  const html = await fetchText(url, {
    headers: {
      'user-agent': BROWSER_USER_AGENT,
    },
  });
  return parseSyumimaniaTableHtml(html, {
    seedBaseline: latestSeedBaseline(seedDraws),
    gameNamePattern,
    numberCount,
    specialCount,
  });
}

function parseSyumimaniaTableHtml(html, {
  seedBaseline,
  gameNamePattern,
  numberCount,
  specialCount,
}) {
  const draws = [];
  const headingPattern = new RegExp(
    `<h[23][^>]*>[\\s\\S]*?第\\s*(\\d+)\\s*回\\s*${gameNamePattern}[\\s\\S]*?<\\/h[23]>`,
    'g',
  );
  const headings = [];
  let match;
  while ((match = headingPattern.exec(html)) != null) {
    headings.push({
      drawId: String(Number.parseInt(match[1], 10)),
      start: match.index,
      end: headingPattern.lastIndex,
    });
  }

  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    const nextStart = headings[i + 1]?.start ?? html.length;
    const block = html.slice(heading.end, nextStart);
    const tableMatch = block.match(/<table[\s\S]*?<\/table>/);
    if (!tableMatch) continue;
    const mainRowNumbers = parseSyumimaniaRowNumbers(tableMatch[0], '本数字');
    const numbers = mainRowNumbers.slice(0, numberCount);
    let specialNumbers = parseSyumimaniaParenthesizedRowNumbers(tableMatch[0], '本数字').slice(0, specialCount);
    if (specialNumbers.length === 0) {
      specialNumbers = parseSyumimaniaRowNumbers(tableMatch[0], 'ボーナス数字', {
        excludeLabels: ['本数字'],
      }).slice(0, specialCount);
    }
    if (specialNumbers.length === 0 && mainRowNumbers.length >= numberCount + specialCount) {
      specialNumbers = mainRowNumbers.slice(numberCount, numberCount + specialCount);
    }
    if (numbers.length !== numberCount || specialNumbers.length !== specialCount) continue;
    const drawDate = deriveScheduledDrawDate(seedBaseline, heading.drawId);
    if (!drawDate) continue;
    draws.push(
      unofficialBackupDraw({
        drawId: heading.drawId,
        drawDate,
        numbers,
        specialNumbers,
        sourceName: 'takarakuji.syumimania.com',
      }),
    );
  }
  return draws;
}

function findSyumimaniaRow(tableHtml, label, { excludeLabels = [] } = {}) {
  const rowPattern = /<tr[\s\S]*?<\/tr>/g;
  return [...tableHtml.matchAll(rowPattern)]
    .map((match) => match[0])
    .find((item) => {
      const text = normalizeJapaneseText(stripHtml(item));
      return text.includes(label) && excludeLabels.every((exclude) => !text.includes(exclude));
    });
}

function parseSyumimaniaRowNumbers(tableHtml, label, options = {}) {
  const row = findSyumimaniaRow(tableHtml, label, options);
  if (!row || row.includes('***')) return [];
  return [...row.matchAll(/<td[^>]*>\s*\(?\s*(\d{1,2})\s*\)?\s*<\/td>/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter(Number.isFinite);
}

function parseSyumimaniaParenthesizedRowNumbers(tableHtml, label, options = {}) {
  const row = findSyumimaniaRow(tableHtml, label, options);
  if (!row || row.includes('***')) return [];
  return [...row.matchAll(/\(\s*(\d{1,2})\s*\)/g)]
    .map((match) => Number.parseInt(match[1], 10))
    .filter(Number.isFinite);
}

function latestSeedBaseline(seedDraws) {
  if (!Array.isArray(seedDraws) || seedDraws.length === 0) return null;
  return seedDraws.reduce((latest, draw) => {
    if (!draw?.drawId || !draw?.drawDate) return latest;
    if (!latest) return draw;
    return draw.drawDate.localeCompare(latest.drawDate) > 0 ||
      (draw.drawDate === latest.drawDate && String(draw.drawId).localeCompare(String(latest.drawId)) > 0)
      ? draw
      : latest;
  }, null);
}

function deriveScheduledDrawDate(seedBaseline, drawId) {
  if (!seedBaseline) return null;
  const baselineId = Number.parseInt(seedBaseline.drawId, 10);
  const targetId = Number.parseInt(drawId, 10);
  const baselineDate = normalizeDrawDate(seedBaseline.drawDate);
  if (!Number.isFinite(baselineId) || !Number.isFinite(targetId) || !baselineDate) return null;
  const date = new Date(`${baselineDate}T00:00:00Z`);
  if (targetId === baselineId) return baselineDate;
  const step = targetId > baselineId ? 1 : -1;
  let cursorId = baselineId;
  while (cursorId !== targetId) {
    date.setUTCDate(date.getUTCDate() + step);
    if (isJapaneseDrawWeekday(date, baselineDate)) {
      cursorId += step;
    }
  }
  return date.toISOString().slice(0, 10);
}

function isJapaneseDrawWeekday(date, baselineDate) {
  const weekday = date.getUTCDay();
  const baselineWeekday = new Date(`${baselineDate}T00:00:00Z`).getUTCDay();
  if (baselineWeekday === 2) return weekday === 2;
  if (baselineWeekday === 5) return weekday === 5;
  return weekday === 1 || weekday === 4;
}

async function readSeedDraws(game) {
  const indexPath = resolve(
    publicDataDir,
    'markets',
    game.pathMarket,
    game.pathGame,
    'draws-index.json',
  );
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, 'utf8'));
  } catch (_error) {
    return [];
  }

  const draws = [];
  for (const year of Array.isArray(index.years) ? index.years : []) {
    if (typeof year.path !== 'string') continue;
    const yearPath = resolve(publicDataDir, year.path);
    try {
      const yearPayload = JSON.parse(await readFile(yearPath, 'utf8'));
      if (Array.isArray(yearPayload.draws)) {
        draws.push(...yearPayload.draws.map(seedDraw).filter(Boolean));
      }
    } catch (_error) {
      // Missing seed shards should not block official regeneration.
    }
  }
  return draws;
}

function buildIndexFile(outputs) {
  const byMarket = new Map();
  for (const output of outputs) {
    const list = byMarket.get(output.game.marketId) ?? [];
    list.push(indexGameEntry(output));
    byMarket.set(output.game.marketId, list);
  }

  return [
    {
      key: 'index.json',
      body: stableJson({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: checkedAt,
        markets: [...byMarket.entries()].map(([marketId, marketGames]) => ({
          marketId,
          games: marketGames,
        })),
      }),
    },
  ];
}

async function buildMergedIndexFile(outputs) {
  let existing;
  try {
    existing = JSON.parse(await readFile(resolve(publicDataDir, 'index.json'), 'utf8'));
  } catch (_error) {
    existing = null;
  }

  const byMarket = new Map();
  for (const market of Array.isArray(existing?.markets) ? existing.markets : []) {
    if (typeof market.marketId !== 'string') continue;
    byMarket.set(market.marketId, Array.isArray(market.games) ? [...market.games] : []);
  }

  for (const output of outputs) {
    const list = byMarket.get(output.game.marketId) ?? [];
    const entry = indexGameEntry(output);
    const index = list.findIndex((item) => item?.gameId === output.game.gameId);
    if (index >= 0) {
      list[index] = entry;
    } else {
      list.push(entry);
    }
    byMarket.set(output.game.marketId, list);
  }

  return {
    key: 'index.json',
    body: stableJson({
      schemaVersion: SCHEMA_VERSION,
      generatedAt: checkedAt,
      markets: [...byMarket.entries()].map(([marketId, marketGames]) => ({
        marketId,
        games: marketGames,
      })),
    }),
  };
}

function indexGameEntry(output) {
  return {
    gameId: output.game.gameId,
    latestDrawId: output.latestDraw.drawId,
    latestPath: gameKey(output.game, 'latest.json'),
    drawsIndexPath: gameKey(output.game, 'draws-index.json'),
    allDrawsPath: gameKey(output.game, 'draws-all.json'),
    verificationStatus: output.verificationStatus,
  };
}

function buildGameFiles({ game, draws, latestDraw, verificationStatus, sourceSummary }) {
  const years = new Map();
  for (const draw of draws) {
    const year = draw.drawDate.slice(0, 4);
    const list = years.get(year) ?? [];
    list.push(draw);
    years.set(year, list);
  }

  const yearEntries = [...years.entries()].sort(([a], [b]) => a.localeCompare(b));
  const yearIndex = yearEntries.map(([year, yearDraws]) => ({
    year,
    drawCount: yearDraws.length,
    firstDrawDate: yearDraws[0]?.drawDate ?? null,
    latestDrawDate: yearDraws[yearDraws.length - 1]?.drawDate ?? null,
    path: gameKey(game, `draws-${year}.json`),
  }));

  const files = [
    {
      key: gameKey(game, 'latest.json'),
      body: stableJson({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: checkedAt,
        marketId: game.marketId,
        gameId: game.gameId,
        latestDraw,
        recentDraws: draws.slice(-20),
        verificationStatus,
        sourceSummary,
      }),
    },
    {
      key: gameKey(game, 'draws-index.json'),
      body: stableJson({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: checkedAt,
        marketId: game.marketId,
        gameId: game.gameId,
        totalDrawCount: draws.length,
        latestDrawId: latestDraw.drawId,
        latestDrawDate: latestDraw.drawDate,
        years: yearIndex,
        verificationStatus,
        sourceSummary,
      }),
    },
    {
      key: gameKey(game, 'draws-all.json'),
      body: stableJson({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: checkedAt,
        marketId: game.marketId,
        gameId: game.gameId,
        totalDrawCount: draws.length,
        draws,
        verificationStatus,
        sourceSummary,
      }),
    },
  ];

  for (const [year, yearDraws] of yearEntries) {
    files.push({
      key: gameKey(game, `draws-${year}.json`),
      body: stableJson({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: checkedAt,
        marketId: game.marketId,
        gameId: game.gameId,
        year,
        drawCount: yearDraws.length,
        draws: yearDraws,
        verificationStatus,
        sourceSummary,
      }),
    });
  }

  return files;
}

function gameKey(game, leaf) {
  return `markets/${game.pathMarket}/${game.pathGame}/${leaf}`;
}

function mergeDraws({ seedDraws, unofficialDraws = [], officialDraws }) {
  const byDrawId = new Map();
  for (const draw of seedDraws) {
    byDrawId.set(draw.drawId, draw);
  }
  for (const draw of unofficialDraws) {
    const existing = byDrawId.get(draw.drawId);
    if (!existing || existing.verificationStatus !== 'official') {
      byDrawId.set(draw.drawId, draw);
    }
  }
  for (const draw of officialDraws) {
    byDrawId.set(draw.drawId, draw);
  }
  return [...byDrawId.values()].sort(
    (a, b) => a.drawDate.localeCompare(b.drawDate) || a.drawId.localeCompare(b.drawId),
  );
}

function mergedVerificationStatus(draws, officialState, seedDraws) {
  const latestDraw = draws[draws.length - 1];
  if (latestDraw?.verificationStatus === 'unofficial_backup_unverified') {
    return 'official_with_unofficial_backup';
  }
  if (
    officialState.ok &&
    draws.some((draw) => draw.verificationStatus === 'fallback')
  ) {
    return 'official_with_fallback_history';
  }
  return officialState.ok ? 'official' : seedVerificationStatus(seedDraws);
}

function seedVerificationStatus(seedDraws) {
  if (seedDraws.length === 0) return 'official_seed';
  return seedDraws.every((draw) => draw.verificationStatus === 'official')
    ? 'official'
    : 'official_seed';
}

function officialDraw({ drawId, drawDate, numbers, specialNumber, specialNumbers }) {
  const resolvedSpecialNumbers =
    Array.isArray(specialNumbers) && specialNumbers.length > 0
      ? specialNumbers.map(Number)
      : specialNumber == null
        ? []
        : [Number(specialNumber)];
  return {
    drawId: stringValue(drawId),
    drawDate,
    numbers: numbers.map(Number),
    specialNumber: resolvedSpecialNumbers[0] ?? null,
    specialNumbers: resolvedSpecialNumbers,
    status: 'official',
    verificationStatus: 'official',
  };
}

function unofficialBackupDraw({ drawId, drawDate, numbers, specialNumber, specialNumbers, sourceName }) {
  const resolvedSpecialNumbers =
    Array.isArray(specialNumbers) && specialNumbers.length > 0
      ? specialNumbers.map(Number)
      : specialNumber == null
        ? []
        : [Number(specialNumber)];
  return {
    drawId: stringValue(drawId),
    drawDate,
    numbers: numbers.map(Number),
    specialNumber: resolvedSpecialNumbers[0] ?? null,
    specialNumbers: resolvedSpecialNumbers,
    status: 'unofficial_backup',
    verificationStatus: 'unofficial_backup_unverified',
    sourceName,
  };
}

function seedDraw(value) {
  if (!value || typeof value !== 'object') return null;
  const drawId = stringValue(value.drawId);
  const drawDate = normalizeDrawDate(value.drawDate);
  const numbers = Array.isArray(value.numbers) ? value.numbers.map(parseInteger).filter((v) => v != null) : [];
  if (!drawId || !drawDate || numbers.length === 0) return null;
  return {
    drawId,
    drawDate,
    numbers,
    specialNumber: parseInteger(value.specialNumber),
    specialNumbers: parseSpecialNumbers(value),
    status: value.status ?? 'official_seed',
    verificationStatus: value.verificationStatus ?? 'official_seed',
  };
}

function parseSpecialNumbers(value, expectedCount = null) {
  const raw = Array.isArray(value.specialNumbers) ? value.specialNumbers : null;
  const specialNumbers = raw
    ? raw.map(parseInteger).filter((item) => item != null)
    : [];
  if (specialNumbers.length > 0) return specialNumbers;

  const specialNumber = parseInteger(value.specialNumber);
  if (specialNumber == null) return [];
  if (expectedCount != null && expectedCount > 1) return [specialNumber];
  return [specialNumber];
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);
  return JSON.parse(text);
}

async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json,text/html,*/*',
        'user-agent': USER_AGENT,
        ...(options.headers ?? {}),
      },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${url} failed: HTTP ${response.status} ${text.slice(0, 120)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchShiftJisText(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'text/csv,text/plain,*/*',
        'user-agent': USER_AGENT,
        ...(options.headers ?? {}),
      },
    });
    const body = await response.arrayBuffer();
    const text = new TextDecoder('shift_jis').decode(body);
    if (!response.ok) {
      throw new Error(`${url} failed: HTTP ${response.status} ${text.slice(0, 120)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function defaultOfficialFetchWindows(date) {
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const windows = [];
  let cursor = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 44);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    windows.push({
      startDate: formatHkjcDate(cursor),
      endDate: formatHkjcDate(chunkEnd),
    });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return windows;
}

function formatHkjcDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function parseNumberList(value) {
  if (Array.isArray(value)) {
    return value.map(parseInteger).filter((item) => item != null);
  }
  if (typeof value === 'string') {
    return value
      .split(/[^0-9]+/)
      .map(parseInteger)
      .filter((item) => item != null);
  }
  return [];
}

function parseInteger(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDrawDate(value) {
  if (value == null) return null;
  const text = String(value).trim();
  const ymd = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  return null;
}

function normalizeJapaneseDrawDate(value) {
  if (value == null) return null;
  const text = String(value).trim();
  const western = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (western) {
    return `${western[1]}-${western[2].padStart(2, '0')}-${western[3].padStart(2, '0')}`;
  }
  const era = text.match(/(昭和|平成|令和)(元|\d+)年(\d{1,2})月(\d{1,2})日/);
  if (!era) return null;
  const eraYear = era[2] === '元' ? 1 : Number.parseInt(era[2], 10);
  const baseYear = {
    昭和: 1925,
    平成: 1988,
    令和: 2018,
  }[era[1]];
  if (!baseYear || !Number.isFinite(eraYear)) return null;
  const year = String(baseYear + eraYear);
  return `${year}-${era[3].padStart(2, '0')}-${era[4].padStart(2, '0')}`;
}

function stringValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function stripHtml(html) {
  return decodeHtml(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeJapaneseText(value) {
  return value
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[（）]/g, (char) => (char === '（' ? '(' : ')'))
    .replace(/\s+/g, ' ')
    .trim();
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
