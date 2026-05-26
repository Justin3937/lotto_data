import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SCHEMA_VERSION = 1;
const USER_AGENT = 'lotto-data-github-pages/0.2';
const HKJC_GRAPHQL_ENDPOINT = 'https://info.cld.hkjc.com/graphql/base/';
const POWERBALL_ENDPOINT =
  'https://data.ny.gov/resource/d6yy-54nr.json?$limit=50000&$order=draw_date';
const MEGA_MILLIONS_ENDPOINT =
  'https://data.ny.gov/resource/5xaw-6ayf.json?$limit=50000&$order=draw_date';
const MIZUHO_BASE = 'https://www.mizuhobank.co.jp';
const FETCH_TIMEOUT_MS = 20000;
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
        type: 'loto6',
        currentPath: '/takarakuji/check/loto/loto6/index.html',
        oldPrefix: 'loto6',
        numberCount: 6,
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

async function fetchOfficialMizuhoLoto({ type, currentPath, oldPrefix, numberCount }) {
  const urls = new Set([new URL(currentPath, MIZUHO_BASE).toString()]);
  const indexUrl = new URL('/takarakuji/check/loto/backnumber/index.html', MIZUHO_BASE).toString();
  const indexHtml = await fetchText(indexUrl);
  for (const url of extractMizuhoLinks(indexHtml, type)) {
    urls.add(url);
  }

  if (urls.size <= 1) {
    for (const url of buildMizuhoFallbackUrls({ type, oldPrefix })) {
      urls.add(url);
    }
  }

  const draws = [];
  for (const url of urls) {
    const html = await fetchText(url);
    draws.push(...parseMizuhoLotoHtml(html, { numberCount }));
  }
  return draws;
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
  const estimatedLatest = type === 'loto6' ? 2100 : 1400;
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

function parseMizuhoLotoHtml(html, { numberCount }) {
  const text = normalizeJapaneseText(stripHtml(html));
  const draws = [];
  const pattern = /第\s*(\d+)\s*回\s+(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日[^0-9]{0,40}((?:\d{1,2}\s+){5,8})/g;
  let match;
  while ((match = pattern.exec(text)) != null) {
    const allNumbers = parseNumberList(match[5]);
    if (allNumbers.length < numberCount + 1) continue;
    const numbers = allNumbers.slice(0, numberCount);
    const specialNumber = allNumbers[numberCount];
    draws.push(
      officialDraw({
        drawId: match[1],
        drawDate: `${match[2]}-${match[3].padStart(2, '0')}-${match[4].padStart(2, '0')}`,
        numbers,
        specialNumber,
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

function officialDraw({ drawId, drawDate, numbers, specialNumber }) {
  return {
    drawId: stringValue(drawId),
    drawDate,
    numbers: numbers.map(Number),
    specialNumber,
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
    status: value.status ?? 'official_seed',
    verificationStatus: value.verificationStatus ?? 'official_seed',
  };
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
