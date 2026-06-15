const MARKETS = {
  KR: { label: "\uD55C\uAD6D", eyebrow: "Korea" },
  JP: { label: "\uC77C\uBCF8", eyebrow: "Japan" },
  US: { label: "\uBBF8\uAD6D", eyebrow: "United States" },
};

const tableBody = document.querySelector("#rankingRows");
const marketTabs = document.querySelector("#marketTabs");
const searchInput = document.querySelector("#gameSearch");
const selectedMarketName = document.querySelector("#selectedMarketName");
const gameCount = document.querySelector("#gameCount");
const riseCount = document.querySelector("#riseCount");
const fallCount = document.querySelector("#fallCount");
const lastSyncedAt = document.querySelector("#lastSyncedAt");
const activeMarketLabel = document.querySelector("#activeMarketLabel");

let activeMarket = "KR";
let rankingsByMarket = Object.fromEntries(Object.keys(MARKETS).map((market) => [market, []]));
let marketState = Object.fromEntries(
  Object.keys(MARKETS).map((market) => [
    market,
    { status: "idle", collectedAt: null, error: null, source: null },
  ]),
);

function render() {
  const rows = rankingsByMarket[activeMarket];
  const state = marketState[activeMarket];
  const query = searchInput.value.trim().toLocaleLowerCase("ko-KR");
  const visibleRows = query
    ? rows.filter((row) => row.gameName.toLocaleLowerCase("ko-KR").includes(query))
    : rows;

  renderSummary(rows, state);

  if (state.status === "loading") {
    renderTableMessage("\uC2E4\uC81C \uB370\uC774\uD130 \uB85C\uB529 \uC911");
  } else if (state.status === "error") {
    renderTableMessage(state.error || "API \uC624\uB958");
  } else {
    renderTable(visibleRows);
  }
}

async function loadMarket(marketCode, options = {}) {
  if (!options.force && marketState[marketCode].status === "loaded") return;

  if (window.location.protocol === "file:") {
    marketState[marketCode] = {
      status: "error",
      collectedAt: null,
      source: null,
      error:
        "\uBAA9\uC5C5 \uB370\uC774\uD130\uB294 \uC0AC\uC6A9\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4. npm.cmd start \uC2E4\uD589 \uD6C4 http://localhost:8080\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694.",
    };
    rankingsByMarket[marketCode] = [];
    render();
    return;
  }

  marketState[marketCode] = {
    ...marketState[marketCode],
    status: "loading",
    error: null,
  };
  render();

  try {
    const payload = await fetchLatestRankings(marketCode);

    rankingsByMarket[marketCode] = normalizeApiRows(payload, marketCode);
    marketState[marketCode] = {
      status: "loaded",
      collectedAt: payload.collectedAt || null,
      source: payload.source || null,
      error: null,
    };
  } catch (error) {
    rankingsByMarket[marketCode] = [];
    marketState[marketCode] = {
      status: "error",
      collectedAt: null,
      source: null,
      error: error.message,
    };
  }

  render();
}

async function fetchLatestRankings(marketCode) {
  const staticDataPath = `data/latest-${marketCode}.json`;

  try {
    const staticResponse = await fetch(staticDataPath, { cache: "no-store" });
    if (staticResponse.ok) return staticResponse.json();
  } catch {
    // Local API fallback below keeps development convenient.
  }

  const response = await fetch(`/api/rankings/latest?market=${marketCode}`, { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Rankings API failed: ${response.status}`);
  }
  return payload;
}

function normalizeApiRows(payload, marketCode) {
  return (payload.rows || []).map((row, index) => {
    const rank = Number(row.rank ?? index + 1);
    const rawChange = row.rankChange ?? row.rank_change;
    const rankChange = rawChange === null || rawChange === undefined ? null : Number(rawChange);

    return {
      marketCode,
      rank,
      gameName: String(row.gameName ?? row.game_name ?? ""),
      releaseCountry: String(row.releaseCountry ?? row.release_country ?? ""),
      rankChange: Number.isFinite(rankChange) ? rankChange : null,
    };
  });
}

function renderSummary(rows, state) {
  const market = MARKETS[activeMarket];
  selectedMarketName.textContent = market.label;
  activeMarketLabel.textContent = market.eyebrow;
  gameCount.textContent = rows.length.toLocaleString("ko-KR");
  riseCount.textContent = rows.filter((row) => row.rankChange > 0).length.toString();
  fallCount.textContent = rows.filter((row) => row.rankChange < 0).length.toString();
  lastSyncedAt.textContent = state.collectedAt ? formatDateTime(state.collectedAt) : "-";
}

function renderTable(rows) {
  if (rows.length === 0) {
    renderTableMessage("\uB370\uC774\uD130 \uC5C6\uC74C");
    return;
  }

  tableBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td><span class="rank-number">${row.rank}</span></td>
          <td>
            <span class="game-title">${escapeHtml(row.gameName)}</span>
            <span class="game-subtitle">${MARKETS[row.marketCode].label} Play Store</span>
          </td>
          <td><span class="country-badge">${escapeHtml(row.releaseCountry || "-")}</span></td>
          <td>${renderRankChange(row.rankChange)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderTableMessage(message) {
  tableBody.innerHTML = `<tr><td class="empty-state" colspan="4">${escapeHtml(message)}</td></tr>`;
}

function renderRankChange(change) {
  if (change === null || change === undefined) {
    return `<span class="change flat" aria-label="comparison unavailable"><span>-</span></span>`;
  }

  if (change > 0) {
    return `<span class="change up" aria-label="rank up ${change}"><span>&#9650;</span><span>+${change}</span></span>`;
  }

  if (change < 0) {
    return `<span class="change down" aria-label="rank down ${Math.abs(change)}"><span>&#9660;</span><span>${change}</span></span>`;
  }

  return `<span class="change flat" aria-label="rank unchanged"><span>&#9473;</span><span>0</span></span>`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

marketTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-market]");
  if (!button) return;

  activeMarket = button.dataset.market;
  searchInput.value = "";

  document.querySelectorAll(".market-tab").forEach((tab) => {
    const isActive = tab === button;
    tab.classList.toggle("is-active", isActive);
    tab.setAttribute("aria-selected", isActive.toString());
  });

  render();
  loadMarket(activeMarket);
});

searchInput.addEventListener("input", render);

render();
loadMarket(activeMarket);
