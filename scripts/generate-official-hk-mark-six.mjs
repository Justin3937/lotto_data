import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MARKET_ID = 'HK';
const GAME_ID = 'mark_six';
const SCHEMA_VERSION = 1;
const HKJC_GRAPHQL_ENDPOINT = 'https://info.cld.hkjc.com/graphql/base/';
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
const now = new Date();
const checkedAt = now.toISOString();
const windows = defaultOfficialFetchWindows(now);
const draws = [];

for (const window of windows) {
  const raw = await fetchOfficialMarkSix(window);
  draws.push(...parseHkjcMarkSix(raw));
}

const uniqueDraws = mergeDraws(draws);
if (uniqueDraws.length === 0) {
  throw new Error('HKJC returned zero parsed Mark Six draws');
}

const latestDraw = uniqueDraws[uniqueDraws.length - 1];
const files = buildFiles({
  checkedAt,
  draws: uniqueDraws,
  latestDraw,
});

for (const file of files) {
  const path = resolve(publicDataDir, file.key);
  await mkdir(resolve(path, '..'), { recursive: true });
  await writeFile(path, file.body, 'utf8');
  console.log(`Wrote data/${file.key}`);
}

function defaultOfficialFetchWindows(date) {
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const windows = [];
  let cursor = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));

  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 44);
    if (chunkEnd > end) {
      chunkEnd.setTime(end.getTime());
    }
    windows.push({
      startDate: formatHkjcDate(cursor),
      endDate: formatHkjcDate(chunkEnd),
    });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return windows;
}

async function fetchOfficialMarkSix({ startDate, endDate }) {
  const response = await fetch(HKJC_GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      accept: 'application/json,*/*',
      'content-type': 'application/json',
      origin: 'https://bet.hkjc.com',
      referer: 'https://bet.hkjc.com/marksix/?lang=en',
      'user-agent': 'lotto-data-github-pages/0.1',
    },
    body: JSON.stringify({
      operationName: 'marksixResult',
      query: HKJC_MARK_SIX_QUERY,
      variables: {
        startDate,
        endDate,
        drawType: 'All',
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`HKJC request failed: HTTP ${response.status}`);
  }

  const json = await response.json();
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    const message = json.errors.map((error) => error.message ?? String(error)).join('; ');
    throw new Error(`HKJC GraphQL returned errors: ${message}`);
  }

  return json;
}

function parseHkjcMarkSix(payload) {
  const records = Array.isArray(payload?.data?.lotteryDraws) ? payload.data.lotteryDraws : [];
  return records.map(parseHkjcRecord).filter(Boolean);
}

function parseHkjcRecord(record) {
  const drawId = stringValue(
    record.id ??
      record.drawId ??
      record.drawNo ??
      record.draw_no ??
      record.no ??
      record.issue ??
      record.draw,
  );
  const drawDate = normalizeDrawDate(
    record.date ?? record.drawDate ?? record.draw_date ?? record.openDate ?? record.year,
  );
  const numbers = extractNumbers(record);
  const specialNumber = extractSpecialNumber(record);

  if (!drawId || !drawDate || numbers.length !== 6 || specialNumber == null) {
    return null;
  }

  return {
    drawId,
    drawDate,
    numbers,
    specialNumber,
    status: 'official',
    verificationStatus: 'official',
  };
}

function extractNumbers(record) {
  const candidates = [
    record.drawResult?.drawnNo,
    record.numbers,
    record.number,
    record.drawResult,
    record.draw_result,
    record.winningNumbers,
    record.winning_numbers,
    record.no,
  ];

  for (const candidate of candidates) {
    const numbers = parseNumberList(candidate).slice(0, 6);
    if (numbers.length === 6) return numbers;
  }

  const positional = [];
  for (let i = 1; i <= 6; i += 1) {
    const value =
      record[`no${i}`] ??
      record[`num${i}`] ??
      record[`number${i}`] ??
      record[`n${i}`] ??
      record[`draw${i}`];
    const parsed = parseInteger(value);
    if (parsed != null) positional.push(parsed);
  }
  return positional.length === 6 ? positional : [];
}

function extractSpecialNumber(record) {
  const value =
    record.drawResult?.xDrawnNo ??
    record.sno ??
    record.special ??
    record.specialNumber ??
    record.special_number ??
    record.extra ??
    record.bonus ??
    record.no7 ??
    record.num7 ??
    record.number7;
  return parseInteger(value);
}

function buildFiles({ checkedAt, draws, latestDraw }) {
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
    path: `markets/hk/mark-six/draws-${year}.json`,
  }));

  const files = [
    {
      key: 'index.json',
      body: stableJson({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: checkedAt,
        markets: [
          {
            marketId: MARKET_ID,
            games: [
              {
                gameId: GAME_ID,
                latestDrawId: latestDraw.drawId,
                latestPath: 'markets/hk/mark-six/latest.json',
                drawsIndexPath: 'markets/hk/mark-six/draws-index.json',
              },
            ],
          },
        ],
      }),
    },
    {
      key: 'markets/hk/mark-six/latest.json',
      body: stableJson({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: checkedAt,
        marketId: MARKET_ID,
        gameId: GAME_ID,
        latestDraw,
        recentDraws: draws.slice(-20),
        verificationStatus: 'official',
      }),
    },
    {
      key: 'markets/hk/mark-six/draws-index.json',
      body: stableJson({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: checkedAt,
        marketId: MARKET_ID,
        gameId: GAME_ID,
        totalDrawCount: draws.length,
        latestDrawId: latestDraw.drawId,
        latestDrawDate: latestDraw.drawDate,
        years: yearIndex,
        verificationStatus: 'official',
      }),
    },
  ];

  for (const [year, yearDraws] of yearEntries) {
    files.push({
      key: `markets/hk/mark-six/draws-${year}.json`,
      body: stableJson({
        schemaVersion: SCHEMA_VERSION,
        generatedAt: checkedAt,
        marketId: MARKET_ID,
        gameId: GAME_ID,
        year,
        drawCount: yearDraws.length,
        draws: yearDraws,
        verificationStatus: 'official',
      }),
    });
  }

  return files;
}

function mergeDraws(draws) {
  const byDrawId = new Map();
  for (const draw of draws) {
    byDrawId.set(draw.drawId, draw);
  }
  return [...byDrawId.values()].sort(
    (a, b) => a.drawDate.localeCompare(b.drawDate) || a.drawId.localeCompare(b.drawId),
  );
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
  if (ymd) {
    return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
  }
  return null;
}

function formatHkjcDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function stringValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\\n`;
}
