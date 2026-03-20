/**
 * Global Control Index (GCI) algorithm.
 * This module is intentionally separate from UI code.
 *
 * Inputs:
 * - Aggregated news items (articles from one or more feeds)
 * - Structural world-state indicators (maintained JSON state)
 *
 * Output:
 * - score 0..100
 * - component breakdown + confidence
 */

const DEFAULT_WEIGHTS = {
  structural: 0.55,
  events: 0.45
};

const STRUCTURAL_WEIGHTS = {
  allianceConcentration: 0.24,
  tradeDependenceConcentration: 0.22,
  conflictCentralization: 0.28,
  governancePressure: 0.26
};

const EVENT_BUCKETS = {
  blocAlignment: [
    "great power competition",
    "power bloc",
    "sphere of influence",
    "geopolitics",
    "regional hegemony",
    "military alliance",
    "security pact",
    "strategic partnership",
    "defense cooperation",
    "joint military exercise"
  ],
  coercivePressure: [
    "export controls",
    "economic coercion",
    "currency weaponization",
    "sanctions",
    "secondary sanctions",
    "embargo",
    "blockade",
    "asset freeze"
  ],
  territorialPressure: [
    "proxy war",
    "buffer zone",
    "territorial claim",
    "annex",
    "occupation",
    "incursion",
    "de facto control",
    "separatist region"
  ],
  regimePressure: [
    "state of emergency",
    "authoritarian consolidation",
    "coup",
    "regime change",
    "government collapse",
    "emergency rule",
    "martial law"
  ]
};

function clamp(value, min = 0, max = 100) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function weightedAverage(values, weights) {
  let numerator = 0;
  let denominator = 0;
  for (const key of Object.keys(weights)) {
    const v = Number(values[key] ?? 0);
    const w = Number(weights[key] ?? 0);
    numerator += v * w;
    denominator += w;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function normalizeCount(count, center = 18, steepness = 0.22) {
  // Logistic normalization to avoid linear runaway from headline spikes.
  const x = Number(count) || 0;
  const y = 1 / (1 + Math.exp(-steepness * (x - center)));
  return y * 100;
}

function keywordHits(text, terms) {
  const lower = String(text || "").toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (lower.includes(term)) hits += 1;
  }
  return hits;
}

export function classifyArticle(article) {
  const combined = [article.title, article.description, article.content, article.summary]
    .filter(Boolean)
    .join(" ");

  const result = {
    blocAlignment: keywordHits(combined, EVENT_BUCKETS.blocAlignment),
    coercivePressure: keywordHits(combined, EVENT_BUCKETS.coercivePressure),
    territorialPressure: keywordHits(combined, EVENT_BUCKETS.territorialPressure),
    regimePressure: keywordHits(combined, EVENT_BUCKETS.regimePressure)
  };

  return result;
}

export function scoreEventPressure(articles = []) {
  const totals = {
    blocAlignment: 0,
    coercivePressure: 0,
    territorialPressure: 0,
    regimePressure: 0
  };

  for (const article of articles) {
    const classified = classifyArticle(article);
    totals.blocAlignment += classified.blocAlignment;
    totals.coercivePressure += classified.coercivePressure;
    totals.territorialPressure += classified.territorialPressure;
    totals.regimePressure += classified.regimePressure;
  }

  const normalized = {
    blocAlignment: normalizeCount(totals.blocAlignment, 10, 0.25),
    coercivePressure: normalizeCount(totals.coercivePressure, 10, 0.25),
    territorialPressure: normalizeCount(totals.territorialPressure, 8, 0.3),
    regimePressure: normalizeCount(totals.regimePressure, 7, 0.3)
  };

  const eventScore = weightedAverage(normalized, {
    blocAlignment: 0.24,
    coercivePressure: 0.24,
    territorialPressure: 0.32,
    regimePressure: 0.20
  });

  return {
    score: clamp(eventScore),
    totals,
    normalized
  };
}

export function scoreStructuralState(structuralState = {}) {
  const normalizedState = {
    allianceConcentration: clamp(Number(structuralState.allianceConcentration ?? 50)),
    tradeDependenceConcentration: clamp(Number(structuralState.tradeDependenceConcentration ?? 50)),
    conflictCentralization: clamp(Number(structuralState.conflictCentralization ?? 50)),
    governancePressure: clamp(Number(structuralState.governancePressure ?? 50))
  };

  const structuralScore = weightedAverage(normalizedState, STRUCTURAL_WEIGHTS);
  return {
    score: clamp(structuralScore),
    normalizedState
  };
}

function applyFriction(rawScore) {
  // Non-linear top-end friction:
  // 0-70: mostly linear
  // 70-85: slowed growth
  // 85-100: heavily damped
  const s = clamp(rawScore);
  if (s <= 70) return s;
  if (s <= 85) return 70 + (s - 70) * 0.72;
  return 80.8 + (s - 85) * 0.42;
}

function deriveConfidence(articlesCount, structuralCoverage) {
  const articleFactor = clamp((articlesCount / 40) * 100);
  const structuralFactor = clamp(structuralCoverage * 100);
  const raw = articleFactor * 0.6 + structuralFactor * 0.4;

  if (raw >= 75) return "high";
  if (raw >= 45) return "medium";
  return "low";
}

export function computeGci({
  articles = [],
  structuralState = {},
  weights = DEFAULT_WEIGHTS,
  previousScore = null
} = {}) {
  const events = scoreEventPressure(articles);
  const structural = scoreStructuralState(structuralState);

  const rawComposite =
    events.score * Number(weights.events ?? DEFAULT_WEIGHTS.events) +
    structural.score * Number(weights.structural ?? DEFAULT_WEIGHTS.structural);

  const frictionAdjusted = applyFriction(rawComposite);

  // Smooth day-to-day volatility so users do not see huge jumps.
  let smoothed = frictionAdjusted;
  if (Number.isFinite(previousScore)) {
    smoothed = previousScore * 0.65 + frictionAdjusted * 0.35;
  }

  const structuralCoverage =
    Object.keys(STRUCTURAL_WEIGHTS).filter((k) => Number.isFinite(Number(structuralState[k]))).length /
    Object.keys(STRUCTURAL_WEIGHTS).length;

  const confidence = deriveConfidence(articles.length, structuralCoverage);

  return {
    score: Number(clamp(smoothed).toFixed(1)),
    rawComposite: Number(rawComposite.toFixed(2)),
    frictionAdjusted: Number(frictionAdjusted.toFixed(2)),
    confidence,
    components: {
      events,
      structural
    }
  };
}
