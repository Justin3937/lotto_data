import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const POLL_WINDOW_MINUTES = 60;
export const POLL_OFFSETS_MINUTES = [60, 120, 180];

export const DATA_POLL_SCHEDULES = [
  {
    marketId: 'HK',
    gameId: 'mark_six',
    timezone: 'Asia/Hong_Kong',
    drawTimeLocal: '21:30',
    drawWeekdays: [2, 4, 6],
  },
  {
    marketId: 'JP',
    gameId: 'mini_loto',
    timezone: 'Asia/Tokyo',
    drawTimeLocal: '18:45',
    drawWeekdays: [2],
  },
  {
    marketId: 'JP',
    gameId: 'loto6_jp',
    timezone: 'Asia/Tokyo',
    drawTimeLocal: '18:45',
    drawWeekdays: [1, 4],
  },
  {
    marketId: 'JP',
    gameId: 'loto7_jp',
    timezone: 'Asia/Tokyo',
    drawTimeLocal: '18:45',
    drawWeekdays: [5],
  },
  {
    marketId: 'US',
    gameId: 'powerball',
    timezone: 'America/New_York',
    drawTimeLocal: '22:59',
    drawWeekdays: [1, 3, 6],
  },
  {
    marketId: 'US',
    gameId: 'mega_millions',
    timezone: 'America/New_York',
    drawTimeLocal: '23:00',
    drawWeekdays: [2, 5],
  },
  {
    marketId: 'US',
    gameId: 'lotto_america',
    timezone: 'America/Chicago',
    drawTimeLocal: '21:15',
    drawWeekdays: [1, 3, 6],
  },
];

export function duePollWindow(now, schedule) {
  const nowMs = now.getTime();
  const [hour, minute] = schedule.drawTimeLocal
    .split(':')
    .map((part) => Number.parseInt(part, 10));
  const localToday = zonedDateParts(now, schedule.timezone);
  const candidateDates = [
    {
      year: localToday.year,
      month: localToday.month,
      day: localToday.day,
    },
    addLocalDays(localToday, -1),
  ];

  for (const dateParts of candidateDates) {
    if (
      Array.isArray(schedule.drawWeekdays) &&
      !schedule.drawWeekdays.includes(weekdayIndex(dateParts))
    ) {
      continue;
    }

    const drawAtMs = zonedDateTimeToUtcMillis({
      ...dateParts,
      hour,
      minute,
      timeZone: schedule.timezone,
    });

    for (const offsetMinutes of POLL_OFFSETS_MINUTES) {
      const scheduledMs = drawAtMs + offsetMinutes * 60000;
      const windowEndMs = scheduledMs + POLL_WINDOW_MINUTES * 60000;
      if (nowMs >= scheduledMs && nowMs < windowEndMs) {
        return {
          targetDrawDate: formatLocalDate(dateParts),
          drawAt: new Date(drawAtMs).toISOString(),
          scheduledFor: new Date(scheduledMs).toISOString(),
          offsetMinutes,
        };
      }
    }
  }

  return null;
}

export function duePolls(now = new Date()) {
  return DATA_POLL_SCHEDULES.map((schedule) => ({
    ...schedule,
    poll: duePollWindow(now, schedule),
  })).filter((entry) => entry.poll !== null);
}

function weekdayIndex(dateParts) {
  return new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day)).getUTCDay();
}

function zonedDateTimeToUtcMillis({
  year,
  month,
  day,
  hour,
  minute,
  timeZone,
}) {
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  let guess = desiredAsUtc;

  for (let i = 0; i < 3; i += 1) {
    const actual = zonedDateParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    const diff = actualAsUtc - desiredAsUtc;
    if (diff === 0) break;
    guess -= diff;
  }

  return guess;
}

function zonedDateParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(parts.year, 10),
    month: Number.parseInt(parts.month, 10),
    day: Number.parseInt(parts.day, 10),
    hour: Number.parseInt(parts.hour, 10),
    minute: Number.parseInt(parts.minute, 10),
  };
}

function addLocalDays(dateParts, days) {
  const date = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function formatLocalDate(dateParts) {
  return [
    String(dateParts.year).padStart(4, '0'),
    String(dateParts.month).padStart(2, '0'),
    String(dateParts.day).padStart(2, '0'),
  ].join('-');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const nowArg = process.argv.find((arg) => arg.startsWith('--now='));
  const now = nowArg ? new Date(nowArg.slice('--now='.length)) : new Date();
  const rows = duePolls(now);
  const gameIds = rows.map((row) => row.gameId).join(',');
  const markets = [...new Set(rows.map((row) => row.marketId))].join(',');
  const json = JSON.stringify(rows);

  if (process.argv.includes('--github-output')) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (!outputPath) {
      throw new Error('GITHUB_OUTPUT is not set');
    }
    await appendFile(
      outputPath,
      [
        `game_ids=${gameIds}`,
        `markets=${markets}`,
        `has_due=${rows.length > 0 ? 'true' : 'false'}`,
        `due_json=${json}`,
      ].join('\n') + '\n',
      'utf8',
    );
  } else {
    console.log(JSON.stringify({ checkedAt: now.toISOString(), gameIds, markets, due: rows }, null, 2));
  }
}
