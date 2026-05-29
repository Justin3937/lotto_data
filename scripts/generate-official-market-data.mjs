import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SCHEMA_VERSION = 1;
const USER_AGENT = 'lotto-data-github-pages/0.2';
const HKJC_GRAPHQL_ENDPOINT = 'https://info.cld.hkjc.com/graphql/base/';
const POWERBALL_ENDPOINT =
  'https://data.ny.gov/resource/d6yy-54nr.json?$limit=50000&$order=draw_date';
const MEGA_MILLIONS_ENDPOINT =
  'https://data.ny.gov/resource/5xaw-6ayf.json?$limit=50000&$order=draw_date';
const LOTTO_AMERICA_ARCHIVE_URL = 'https://www.lottoamerica.com/archive';
const MIZUHO_BASE = 'https://www.mizuhobank.co.jp';
const FETCH_TIMEOUT_MS = 20000;
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
  },
  {
    marketId: 'JP',
    gameId: 'mini_loto',
    pathMarket: 'jp',
    pathGame: 'mini-loto',
    fetchOfficial: () =>
      fetchOfficialMizuhoLoto({
        probeFile: 'jp-mini-loto-probe.json',
        type: 'miniloto',
        currentPath: '/takarakuji/check/loto/miniloto/index.html',
        oldPrefix: 'loto',
        numberCount: 5,
      }),
  },
  {
    marketId: 'JP',
    gameId: 'loto6_jp',
    pathMarket: 'jp',
    pathGame: 'loto6',
    fetchOfficial: () =>
      fetchOfficialMizuhoLoto({
        probeFile: 'jp-loto6-probe.json',
        type: 'loto6',
        currentPath: '/takarakuji/check/loto/loto6/index.html',
        oldPrefix: 'loto6',
        numberCount: 6,
      }),
  },
  {
    marketId: 'JP',
    gameId: 'loto7_jp',
    pathMarket: 'jp',
    pathGame: 'loto7',
    fetchOfficial: () =>
      fetchOfficialMizuhoLoto({
        probeFile: 'jp-loto7-probe.json',
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
  },
  {
    marketId: 'US',
    gameId: 'powerball',
    pathMarket: 'us',
    pathGame: 'powerball',
    fetchOfficial: fetchOfficialPowerball,
  },
  {
    marketId: 'US',
    gameId: 'mega_millions',
    pathMarket: 'us',
    pathGame: 'mega-millions',
    fetchOfficial: fetchOfficialMegaMillions,
  },
  {
    marketId: 'US',
    gameId: 'lotto_america',
    pathMarket: 'us',
    pathGame: 'lotto-america',
    fetchOfficial: fetchOfficialLottoAmerica,
  },
];

const generated = [];

for (const game of games) {
  const seedDraws = await readSeedDraws(game);
  const officialState = await safeFetchOfficial(game);
  const draws = mergeDraws({
    seedDraws,
    officialDraws: officialState.draws,
  });

  if (draws.length === 0) {
    throw new Error(`${game.marketId}/${game.gameId} has no seed or official draws`);
  }

  generated.push({
    game,
    draws,
    latestDraw: draws[draws.length - 1],
    verificationStatus: officialState.ok ? 'official' : seedVerificationStatus(seedDraws),
    sourceSummary: {
      official: {
        ok: officialState.ok,
        drawCount: officialState.draws.length,
        error: officialState.error,
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

const files = buildIndexFile(generated);
for (const output of generated) {
  files.push(...buildGameFiles(output));
}

for (const file of files) {
  const path = resolve(publicDataDir, file.key);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, file.body, 'utf8');
  console.log(`Wrote data/${file.key}`);
}

async function safeFetchOfficial(game) {
  try {
    const draws = await game.fetchOfficial();
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
    const html = await fetchText(`${LOTTO_AMERICA_ARCHIVE_URL}/${year}`);
    draws.push(...parseLottoAmericaArchiveHtml(html));
  }
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

async function fetchOfficialMizuhoLoto({
  probeFile,
  type,
  currentPath,
  oldPrefix,
  numberCount,
  specialCount = 1,
  csv = null,
}) {
  const probeDraws = await readProbeDraws(probeFile, { numberCount, specialCount });
  if (probeDraws.length > 0) {
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
  const bonusIndex = numberRow.findIndex((item) => item.includes('ボーナス'));
  const numbers = numberRow.slice(1, 1 + numberCount).map(parseInteger).filter((item) => item != null);
  const specialNumbers =
    bonusIndex >= 0
      ? numberRow
          .slice(bonusIndex + 1, bonusIndex + 1 + specialCount)
          .map(parseInteger)
          .filter((item) => item != null)
      : [];
  if (!drawId || !drawDate || numbers.length !== numberCount || specialNumbers.length !== specialCount) {
    return null;
  }
  return officialDraw({ drawId, drawDate, numbers, specialNumbers });
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

function parseLottoAmericaArchiveHtml(html) {
  const draws = [];
  const cardPattern =
    /<div class="[^"]*\b_date\b[^"]*">[\s\S]*?<strong>([A-Za-z]+)\s+(\d{1,2})<\/strong>,\s*(\d{4})[\s\S]*?<ul class="[^"]*\bballs\b[^"]*">([\s\S]*?)<\/ul>/g;
  let match;
  while ((match = cardPattern.exec(html)) != null) {
    const [, monthName, day, year, listHtml] = match;
    const month = MONTH_NUMBERS[monthName];
    if (!month) continue;
    const values = [...listHtml.matchAll(/<li(?:\s+class="[^"]+")?[^>]*>\s*(\d{1,2})\s*<\/li>/g)]
      .map((item) => Number.parseInt(item[1], 10))
      .filter((item) => Number.isFinite(item));
    if (values.length !== 7) continue;
    draws.push(
      officialDraw({
        drawId: `${year}-${month}-${day.padStart(2, '0')}`,
        drawDate: `${year}-${month}-${day.padStart(2, '0')}`,
        numbers: values.slice(0, 5),
        specialNumber: values[5],
      }),
    );
  }
  return draws;
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
    list.push({
      gameId: output.game.gameId,
      latestDrawId: output.latestDraw.drawId,
      latestPath: gameKey(output.game, 'latest.json'),
      drawsIndexPath: gameKey(output.game, 'draws-index.json'),
      allDrawsPath: gameKey(output.game, 'draws-all.json'),
      verificationStatus: output.verificationStatus,
    });
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

function mergeDraws({ seedDraws, officialDraws }) {
  const byDrawId = new Map();
  for (const draw of seedDraws) {
    byDrawId.set(draw.drawId, draw);
  }
  for (const draw of officialDraws) {
    byDrawId.set(draw.drawId, draw);
  }
  return [...byDrawId.values()].sort(
    (a, b) => a.drawDate.localeCompare(b.drawDate) || a.drawId.localeCompare(b.drawId),
  );
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
