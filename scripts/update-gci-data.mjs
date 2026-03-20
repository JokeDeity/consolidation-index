import { mkdir, readFile, writeFile } from "node:fs/promises";
import { classifyArticle, computeGci } from "../algorithm/gci-algorithm.mjs";

const DATA_DIR = new URL("../data/", import.meta.url);
const LATEST_PATH = new URL("../data/latest.json", import.meta.url);
const HISTORY_PATH = new URL("../data/history.json", import.meta.url);
const FEED_PATH = new URL("../data/feed.json", import.meta.url);
const STATE_PATH = new URL("../data/state.json", import.meta.url);

const QUERIES = [
  '"great power competition" geopolitics',
  'annexation occupation "de facto control"',
  '"military alliance" "security pact"',
  'sanctions embargo "asset freeze"',
  '"regime change" coup emergency rule'
];

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function readJsonOrDefault(path, defaultValue) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch {
    return defaultValue;
  }
}

async function fetchGdeltArticles(query) {
  const encoded = encodeURIComponent(`${query} lang:english`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encoded}&mode=ArtList&maxrecords=35&format=json&sort=DateDesc`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`GDELT request failed (${response.status}) for query "${query}"`);
  }
  const data = await response.json();
  const articles = Array.isArray(data.articles) ? data.articles : [];
  return articles.map((a) => ({
    title: a.title || "Untitled",
    description: a.seendate ? `Detected in global media stream at ${a.seendate}.` : "Detected in global media stream.",
    content: "",
    summary: "Detected in global media stream.",
    link: a.url || "",
    source_name: a.domain || "Unknown source",
    pubDate: a.seendate || new Date().toISOString()
  }));
}

async function aggregateNews() {
  const settled = await Promise.allSettled(QUERIES.map((q) => fetchGdeltArticles(q)));
  const fulfilled = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const merged = fulfilled.flat();

  const unique = uniqueBy(merged, (a) => (a.link || a.title).toLowerCase());
  unique.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  return unique.slice(0, 60);
}

function deriveStructuralState(currentState, articles) {
  // Gradually adjust structural indicators from news pressure.
  // This allows automatic updates while retaining continuity over time.
  const base = {
    allianceConcentration: Number(currentState.allianceConcentration ?? 55),
    tradeDependenceConcentration: Number(currentState.tradeDependenceConcentration ?? 57),
    conflictCentralization: Number(currentState.conflictCentralization ?? 59),
    governancePressure: Number(currentState.governancePressure ?? 53)
  };

  const textBlob = articles.map((a) => `${a.title} ${a.description}`).join(" ").toLowerCase();
  const count = (term) => (textBlob.match(new RegExp(term, "g")) || []).length;

  const allianceDelta = count("alliance|security pact|defense cooperation") * 0.12;
  const tradeDelta = count("sanction|embargo|trade|export control") * 0.1;
  const conflictDelta = count("annex|occupation|incursion|strike|offensive") * 0.14;
  const governanceDelta = count("coup|emergency rule|regime|government collapse") * 0.11;

  const next = {
    allianceConcentration: Math.max(0, Math.min(100, base.allianceConcentration * 0.94 + (base.allianceConcentration + allianceDelta) * 0.06)),
    tradeDependenceConcentration: Math.max(0, Math.min(100, base.tradeDependenceConcentration * 0.94 + (base.tradeDependenceConcentration + tradeDelta) * 0.06)),
    conflictCentralization: Math.max(0, Math.min(100, base.conflictCentralization * 0.94 + (base.conflictCentralization + conflictDelta) * 0.06)),
    governancePressure: Math.max(0, Math.min(100, base.governancePressure * 0.94 + (base.governancePressure + governanceDelta) * 0.06))
  };

  return Object.fromEntries(Object.entries(next).map(([k, v]) => [k, Number(v.toFixed(2))]));
}

function toFeedItems(articles) {
  const scored = articles.map((a) => {
    const c = classifyArticle(a);
    const relevance = c.blocAlignment + c.coercivePressure + c.territorialPressure + c.regimePressure;
    let category = "SHIFT";
    if (c.territorialPressure >= c.coercivePressure && c.territorialPressure >= c.regimePressure && c.territorialPressure >= c.blocAlignment) {
      category = "TERRITORIAL";
    } else if (c.coercivePressure >= c.regimePressure && c.coercivePressure >= c.blocAlignment) {
      category = "COERCIVE";
    } else if (c.regimePressure >= c.blocAlignment) {
      category = "REGIME";
    } else if (c.blocAlignment > 0) {
      category = "ALIGNMENT";
    }
    return { ...a, relevance, category };
  });

  const topical = scored
    .filter((a) => a.relevance > 0)
    .sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return new Date(b.pubDate) - new Date(a.pubDate);
    });

  // If classifier misses exact terms, keep recent query-matched items so feed is never empty.
  const fallbackRecent = scored
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate))
    .slice(0, 30)
    .map((a) => ({
      ...a,
      category: a.category || "SHIFT"
    }));

  const selected = topical.length ? topical.slice(0, 30) : fallbackRecent;

  return selected.map((a) => ({
      title: a.title,
      summary: a.description || "Detected in global media stream.",
      url: a.link,
      source_name: a.source_name,
      published_at: a.pubDate,
      category: a.category
    }));
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });

  const [latestExisting, historyExisting, stateExisting] = await Promise.all([
    readJsonOrDefault(LATEST_PATH, null),
    readJsonOrDefault(HISTORY_PATH, { points: [] }),
    readJsonOrDefault(STATE_PATH, {})
  ]);

  const articles = await aggregateNews();
  const nextStructuralState = deriveStructuralState(stateExisting, articles);
  const previousScore = latestExisting && Number.isFinite(Number(latestExisting.score))
    ? Number(latestExisting.score)
    : null;

  const computed = computeGci({
    articles,
    structuralState: nextStructuralState,
    previousScore
  });

  const nowIso = new Date().toISOString();
  const latestOut = {
    score: computed.score,
    updated_at: nowIso,
    confidence: computed.confidence,
    model: "gci-algorithm-v1",
    components: {
      event_score: computed.components.events.score,
      structural_score: computed.components.structural.score
    }
  };

  const nextHistory = Array.isArray(historyExisting.points) ? [...historyExisting.points] : [];
  nextHistory.push({
    at: nowIso,
    score: computed.score,
    confidence: computed.confidence
  });

  // Keep rolling 365 points (daily cadence).
  const trimmedHistory = nextHistory.slice(-365);

  await Promise.all([
    writeFile(LATEST_PATH, JSON.stringify(latestOut, null, 2) + "\n", "utf8"),
    writeFile(HISTORY_PATH, JSON.stringify({ points: trimmedHistory }, null, 2) + "\n", "utf8"),
    writeFile(FEED_PATH, JSON.stringify({ items: toFeedItems(articles) }, null, 2) + "\n", "utf8"),
    writeFile(STATE_PATH, JSON.stringify(nextStructuralState, null, 2) + "\n", "utf8")
  ]);

  console.log(`GCI updated. score=${computed.score}, confidence=${computed.confidence}, articles=${articles.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
