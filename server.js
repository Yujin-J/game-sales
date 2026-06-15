import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

loadDotEnv();

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const SUPABASE_URL = trimTrailingSlash(process.env.SUPABASE_URL || "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PLAY_STORE_API_URL = process.env.PLAY_STORE_API_URL || "";
const PLAY_STORE_API_KEY = process.env.PLAY_STORE_API_KEY || "";
const SYNC_SECRET = process.env.SYNC_SECRET || "";
const UNKNOWN_VALUE = "\uBBF8\uD655\uC778";
const MARKET_CODES = ["KR", "JP", "US"];
const MARKET_LOCALES = {
  KR: { country: "kr", lang: "ko" },
  JP: { country: "jp", lang: "ja" },
  US: { country: "us", lang: "en" },
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (url.pathname === "/api/rankings/latest" && request.method === "GET") {
      return await handleLatestRankings(url, response);
    }

    if (url.pathname === "/api/sync" && request.method === "POST") {
      return await handleSync(request, response);
    }

    return await serveStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Game sales table listening on ${PORT}`);
});

async function handleLatestRankings(url, response) {
  const market = normalizeMarket(url.searchParams.get("market"));

  if (isSupabaseConfigured()) {
    const latestCollectedAt = await getLatestCollectedAt(market);
    if (latestCollectedAt) {
      const rows = await fetchRowsByCollectedAt(market, latestCollectedAt);

      return sendJson(response, 200, {
        marketCode: market,
        collectedAt: latestCollectedAt,
        source: "supabase",
        rows: rows.map((row) => ({
          rank: row.rank,
          gameName: row.game_infos.game_name,
          releaseCountry: row.game_infos.release_country,
          rankChange: row.rank_change,
        })),
      });
    }
  }

  const liveRows = (await fetchPlayStoreRevenueRankings(market)).slice(0, 100);
  return sendJson(response, 200, {
    marketCode: market,
    collectedAt: new Date().toISOString(),
    source: PLAY_STORE_API_URL ? "external-api" : "google-play-scraper",
    rows: liveRows.map((row, index) => ({
      rank: Number(row.rank || index + 1),
      gameName: row.gameName,
      releaseCountry: row.releaseCountry,
      rankChange: null,
    })),
  });
}

async function handleSync(request, response) {
  if (SYNC_SECRET && request.headers["x-sync-secret"] !== SYNC_SECRET) {
    return sendJson(response, 401, { error: "Unauthorized" });
  }

  assertSupabaseConfigured();

  const collectedAt = new Date().toISOString();
  const rankingDate = formatDateInTimeZone(new Date(collectedAt), "Asia/Seoul");
  const results = [];

  for (const market of MARKET_CODES) {
    const currentRows = (await fetchPlayStoreRevenueRankings(market)).slice(0, 100);
    const gameInfoByKey = await ensureGameInfoRows(currentRows);
    const previousRows = await fetchPreviousSnapshot(market, rankingDate);
    const previousRankByGame = new Map(
      previousRows.map((row) => [gameKey(row.game_infos.game_name, row.game_infos.release_country), Number(row.rank)]),
    );

    const rows = currentRows.map((row, index) => {
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

    await upsertRankingRows(rows);
    results.push({ marketCode: market, insertedRows: rows.length });
  }

  return sendJson(response, 200, { collectedAt, results });
}

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
  let gplay;
  try {
    gplay = (await import("google-play-scraper")).default;
  } catch {
    throw new Error("google-play-scraper dependency is required. Run npm.cmd install first.");
  }

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

async function getLatestCollectedAt(market) {
  const rows = await supabaseGet(
    `/rest/v1/game_daily_rankings?select=collected_at&market_country=eq.${market}&order=collected_at.desc&limit=1`,
  );
  return rows[0]?.collected_at || null;
}

async function fetchRowsByCollectedAt(market, collectedAt) {
  const query = [
    "select=rank,rank_change,game_id,game_infos(game_name,release_country)",
    `market_country=eq.${market}`,
    `collected_at=eq.${encodeURIComponent(collectedAt)}`,
    "order=rank.asc",
    "limit=100",
  ].join("&");
  return supabaseGet(`/rest/v1/game_daily_rankings?${query}`);
}

async function fetchRowsByRankingDate(market, rankingDate) {
  const query = [
    "select=rank,rank_change,game_id,game_infos(game_name,release_country)",
    `market_country=eq.${market}`,
    `ranking_date=eq.${rankingDate}`,
    "order=rank.asc",
    "limit=100",
  ].join("&");
  return supabaseGet(`/rest/v1/game_daily_rankings?${query}`);
}

async function fetchPreviousSnapshot(market, rankingDate) {
  const rows = await supabaseGet(
    `/rest/v1/game_daily_rankings?select=ranking_date&market_country=eq.${market}&ranking_date=lt.${rankingDate}&order=ranking_date.desc&limit=1`,
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

async function serveStatic(pathname, response) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(__dirname, safePath);

  if (!filePath.startsWith(__dirname)) return sendJson(response, 403, { error: "Forbidden" });

  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": getContentType(filePath) });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function normalizeMarket(value) {
  const market = String(value || "KR").toUpperCase();
  if (!MARKET_CODES.includes(market)) throw new Error(`Unsupported market: ${value}`);
  return market;
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
}

function assertSupabaseConfigured() {
  if (!isSupabaseConfigured()) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
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

function getContentType(filePath) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  return types[extname(filePath)] || "application/octet-stream";
}

function trimTrailingSlash(value) {
  return value.replace(/\/$/, "");
}

function getSupabaseAuthHeader(key) {
  return key.startsWith("eyJ") ? { authorization: `Bearer ${key}` } : {};
}

function loadDotEnv() {
  const envPath = fileURLToPath(new URL(".env", import.meta.url));
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

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}
