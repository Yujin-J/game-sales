import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

loadDotEnv();

const UNKNOWN_VALUE = "\uBBF8\uD655\uC778";
const MARKET_CODES = ["KR", "JP", "US"];
const MARKET_LOCALES = {
  KR: { country: "kr", lang: "ko" },
  JP: { country: "jp", lang: "ja" },
  US: { country: "us", lang: "en" },
};

const SUPABASE_URL = trimTrailingSlash(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PLAY_STORE_API_URL = process.env.PLAY_STORE_API_URL || "";
const PLAY_STORE_API_KEY = process.env.PLAY_STORE_API_KEY || "";
const outDir = getArgValue("--out") || join(process.cwd(), "dist", "data");

assertSupabaseConfigured();
await mkdir(outDir, { recursive: true });

const collectedAt = new Date().toISOString();
const rankingDate = formatDateInTimeZone(new Date(collectedAt), "Asia/Seoul");
const results = [];

for (const market of MARKET_CODES) {
  console.log(`sync:start market=${market}`);
  const currentRows = (await fetchPlayStoreRevenueRankings(market)).slice(0, 100);
  console.log(`sync:fetched market=${market} rows=${currentRows.length}`);
  const gameInfoByKey = await ensureGameInfoRows(currentRows);
  console.log(`sync:games market=${market} rows=${gameInfoByKey.size}`);
  const previousRows = await fetchPreviousSnapshot(market, rankingDate);
  console.log(`sync:previous market=${market} rows=${previousRows.length}`);
  const previousRankByGame = new Map(
    previousRows.map((row) => [gameKey(row.game_infos.game_name, row.game_infos.release_country), Number(row.rank)]),
  );

  const rankingRows = currentRows.map((row, index) => {
    const rank = Number(row.rank || index + 1);
    const key = gameKey(row.gameName, row.releaseCountry);
    const gameInfo = gameInfoByKey.get(key);
    if (!gameInfo) throw new Error(`Game info was not saved: ${row.gameName}`);

    const previousRank = previousRankByGame.get(key);
    const rankChange = previousRank ? previousRank - rank : 0;

    return {
      market_country: market,
      collected_at: collectedAt,
      ranking_date: rankingDate,
      rank,
      game_id: gameInfo.id,
      rank_change: rankChange,
    };
  });

  await upsertRankingRows(rankingRows);
  console.log(`sync:rankings market=${market} rows=${rankingRows.length}`);

  const pagePayload = {
    marketCode: market,
    collectedAt,
    source: PLAY_STORE_API_URL ? "external-api" : "google-play-scraper",
    rows: currentRows.map((row, index) => ({
      rank: Number(row.rank || index + 1),
      gameName: row.gameName,
      releaseCountry: row.releaseCountry,
      rankChange: rankingRows[index].rank_change,
    })),
  };

  await writeFile(join(outDir, `latest-${market}.json`), JSON.stringify(pagePayload, null, 2), "utf8");
  results.push({ marketCode: market, rows: rankingRows.length });
}

console.log(JSON.stringify({ collectedAt, rankingDate, results }, null, 2));

async function fetchPlayStoreRevenueRankings(market) {
  if (PLAY_STORE_API_URL) return fetchExternalPlayStoreRankings(market);
  return fetchGooglePlayRankings(market);
}

async function fetchExternalPlayStoreRankings(market) {
  const endpoint = PLAY_STORE_API_URL.includes("{market}")
    ? PLAY_STORE_API_URL.replaceAll("{market}", market)
    : appendMarketParam(PLAY_STORE_API_URL, market);

  const headers = { accept: "application/json" };
  if (PLAY_STORE_API_KEY) headers.authorization = `Bearer ${PLAY_STORE_API_KEY}`;

  const response = await fetch(endpoint, { headers });
  if (!response.ok) throw new Error(`Play Store API failed for ${market}: ${response.status}`);

  const payload = await response.json();
  const items = Array.isArray(payload) ? payload : payload.items || payload.rankings || payload.data || [];
  return items.map((item, index) => normalizeRankingItem(item, index));
}

async function fetchGooglePlayRankings(market) {
  const gplay = (await import("google-play-scraper")).default;
  const locale = MARKET_LOCALES[market];
  const items = await gplay.list({
    collection: gplay.collection.GROSSING,
    category: gplay.category.GAME,
    num: 100,
    country: locale.country,
    lang: locale.lang,
    fullDetail: true,
    throttle: 10,
  });

  return items.map((item, index) =>
    normalizeRankingItem(
      {
        ...item,
        rank: index + 1,
        gameName: item.title,
        gameReleaseDate: item.released,
      },
      index,
    ),
  );
}

function normalizeRankingItem(item, index) {
  return {
    rank: Number(item.rank || item.ranking || index + 1),
    gameName: normalizeText(item.gameName || item.game_name || item.title || item.name),
    genre: normalizeText(item.genre || item.gameGenre || item.category || item.primaryGenre || item.genreId),
    releaseCountry: normalizeText(
      item.releaseCountry || item.release_country || item.countryOfRelease || item.publisherCountry,
    ),
    gameReleaseDate: normalizeDate(
      item.gameReleaseDate || item.game_release_date || item.releaseDate || item.release_date || item.releasedAt,
    ),
  };
}

async function fetchRowsByRankingDate(market, date) {
  const query = [
    "select=rank,rank_change,game_id,game_infos(game_name,release_country)",
    `market_country=eq.${market}`,
    `ranking_date=eq.${date}`,
    "order=rank.asc",
    "limit=100",
  ].join("&");
  return supabaseGet(`/rest/v1/game_daily_rankings?${query}`);
}

async function fetchPreviousSnapshot(market, date) {
  const rows = await supabaseGet(
    `/rest/v1/game_daily_rankings?select=ranking_date&market_country=eq.${market}&ranking_date=lt.${date}&order=ranking_date.desc&limit=1`,
  );
  const previousRankingDate = rows[0]?.ranking_date;
  return previousRankingDate ? fetchRowsByRankingDate(market, previousRankingDate) : [];
}

async function ensureGameInfoRows(rows) {
  const uniqueRows = uniqueBy(rows, (row) => gameKey(row.gameName, row.releaseCountry));
  await insertMissingGameInfoRows(uniqueRows);
  return fetchGameInfoRows(uniqueRows);
}

async function insertMissingGameInfoRows(rows) {
  if (rows.length === 0) return;

  for (const chunk of chunkRows(rows, 25)) {
    const payload = chunk.map((row) => ({
      game_name: row.gameName,
      genre: row.genre,
      release_country: row.releaseCountry,
      game_release_date: row.gameReleaseDate,
    }));

    const response = await supabaseFetch("/rest/v1/game_infos?on_conflict=game_name,release_country", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Supabase game info insert failed: ${response.status} ${await response.text()}`);
    }
  }
}

async function fetchGameInfoRows(rows) {
  if (rows.length === 0) return new Map();

  const names = uniqueBy(
    rows.map((row) => row.gameName),
    (name) => name,
  );
  const dbRows = [];
  for (const chunk of chunkRows(names, 10)) {
    const quotedNames = chunk.map((name) => `"${name.replaceAll('"', '\\"')}"`).join(",");
    const chunkRowsFromDb = await supabaseGet(
      `/rest/v1/game_infos?select=id,game_name,release_country&game_name=in.(${encodeURIComponent(quotedNames)})`,
    );
    dbRows.push(...chunkRowsFromDb);
  }
  const wantedKeys = new Set(rows.map((row) => gameKey(row.gameName, row.releaseCountry)));
  const result = new Map();

  dbRows.forEach((row) => {
    const key = gameKey(row.game_name, row.release_country);
    if (wantedKeys.has(key)) result.set(key, row);
  });

  return result;
}

async function upsertRankingRows(rows) {
  for (const chunk of chunkRows(rows, 25)) {
    const response = await supabaseFetch("/rest/v1/game_daily_rankings?on_conflict=market_country,ranking_date,rank", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });

    if (!response.ok) throw new Error(`Supabase upsert failed: ${response.status} ${await response.text()}`);
  }
}

async function supabaseGet(path) {
  const response = await supabaseFetch(path, { method: "GET" });
  if (!response.ok) throw new Error(`Supabase request failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function supabaseFetch(path, options = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      ...getSupabaseAuthHeader(SUPABASE_SERVICE_ROLE_KEY),
      ...(options.headers || {}),
    },
  });
}

function appendMarketParam(value, market) {
  const url = new URL(value);
  url.searchParams.set("market", market);
  return url.toString();
}

function gameKey(gameName, releaseCountry) {
  return `${gameName}::${releaseCountry}`;
}

function uniqueBy(values, getKey) {
  const seen = new Set();
  return values.filter((value) => {
    const key = getKey(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

function normalizeText(value) {
  const text = String(value || "").trim();
  return text || UNKNOWN_VALUE;
}

function normalizeDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const dotDate = text.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (dotDate) {
    const [, year, month, day] = dotDate;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function formatDateInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function assertSupabaseConfigured() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, "");
}

function getSupabaseAuthHeader(key) {
  return key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {};
}

function getArgValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

function loadDotEnv() {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  if (!existsSync(envPath)) return;

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}
