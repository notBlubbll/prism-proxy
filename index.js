// prism-proxy/index.js - OpenCode V2 plugin: local OpenAI-compatible proxy
// for the PrismRouter (c00l.site) Doway and root endpoints.
//
// It does two things:
//   1. GLOBAL RATE LIMITING - PrismRouter caps the whole key at 30 requests
//      per minute, so every request shares one sliding window. A token window
//      caps the key at 10M tokens per minute as well. Requests queue instead of
//      failing with 429.
//   2. KEY POOL - the proxy owns the credentials, pins each OpenCode session to
//      one key, and records usage per model and per key.
//
// Everything else is a transparent passthrough: the request body (including
// the model id) is forwarded byte-exact and the upstream SSE stream is relayed.
//
// rev: 1 - plugin contract, hot-reload guard, crash guards, EADDRINUSE
//         retry-listen, raw http(s) sockets, streaming passthrough,
//         global sliding-window limiter, key pool, 429 learn + retry,
//         /healthz + /status + /usage.

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Set by hotReload() on the copy of this file that is being replaced. That copy
// keeps finishing the requests it already has, but it must not write keys.json or
// the usage snapshot again: the new copy owns them, and a late write from the old
// one (a debounced save) would put stale state back.
let retired = false;
// The original file and its folder. A hot reload loads a copy of this file under
// another name (see hotReload), so these are fixed by the first copy and handed on.
const ENTRY_FILE = (globalThis.__prismEntry ||= fileURLToPath(import.meta.url));
const HOME_DIR = path.dirname(ENTRY_FILE);
// Identifies this copy of the module (a status call shows which copy answered).
const INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
// Responses this copy is still writing, so a hot reload can mark them to close
// their connection when they finish.
const activeResponses = new Set();


const TAG = "[prism-proxy]";
const UPSTREAM_DEFAULT = "https://claude.c00l.site/doway/v1";
const LISTEN_HOST = "127.0.0.1";
const PORT_DEFAULT = 17334;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

const UPSTREAM = (() => {
  try { return new URL(process.env.PRISM_PROXY_UPSTREAM || UPSTREAM_DEFAULT); }
  catch { return new URL(UPSTREAM_DEFAULT); }
})();
const UPSTREAM_PATH = UPSTREAM.pathname.replace(/\/$/, "");
const ROOT_PATH = UPSTREAM_PATH.replace(/\/doway\/v1$/, "/v1");

// ---- rate limits -----------------------------------------------------------
// PrismRouter caps the whole key, not each model: 30 requests per minute. Every
// request therefore shares one global sliding window. A second, token window
// caps the key at 10M tokens per minute. Per-model limits remain available for
// providers that meter per model (PRISM_PROXY_LIMITS / ..._TOKEN_LIMITS).
// Env format: "model=30/60s" or "global=30/60s".
const LIMITS_DEFAULT = "";
const TOKEN_LIMITS_DEFAULT = "";
const GLOBAL_LIMITS_DEFAULT = "global=30/60s";
const GLOBAL_TOKEN_LIMITS_DEFAULT = "global=10000000/60s";
const ROOT_MODELS = new Map([
  ["claude-opus-4-5", "/messages"], ["claude-sonnet-4-6", "/messages"], ["claude-sonnet-5", "/messages"],
  ["deepseek-v4-flash", "/chat/completions"], ["deepseek-v4-pro", "/chat/completions"],
  ["Kimi-K2.6", "/chat/completions"], ["Kimi-K2.7-Code", "/chat/completions"],
  ["grok-4.7", "/chat/completions"], ["gpt-image-2", "/images/generations"],
]);
// Models the panel's "Ping models" button checks when the request names none.
const PING_MODELS_DEFAULT = [
  "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol", "gpt-6.1-terra",
  "gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna",
  "gpt-5.5", "gpt-5.4", "gpt-5.4-nano", "gpt-5.1", "gpt-5",
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini",
  "gpt-chat-latest", "o3-mini",
];

// USD per 1M tokens from models.dev (provider `opencode`, falling back to
// `openai` for models OpenCode does not list), overridable with PRISM_PROXY_PRICING.
const PRICING_DEFAULT = {
  "claude-opus-4-5": { in: 5, out: 25, cached: 0.5, write: 6.25 },
  "claude-sonnet-4-6": { in: 3, out: 15, cached: 0.3, write: 3.75 },
  "claude-sonnet-5": { in: 2, out: 10, cached: 0.2, write: 2.5 },
  "deepseek-v4-flash": { in: 0.14, out: 0.28, cached: 0.028 },
  "deepseek-v4-pro": { in: 1.74, out: 3.48, cached: 0.145 },
  "Kimi-K2.6": { in: 0.95, out: 4, cached: 0.16 },
  "Kimi-K2.7-Code": { in: 0.95, out: 4, cached: 0.19 },
  "grok-4.7": { in: 2, out: 6, cached: 0.5 },
  "gpt-image-2": { in: 5, out: 30, cached: 1.25, imageInput: 8, imageCached: 2 },
  "gpt-4.1": { in: 2, out: 8, cached: 0.5 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6, cached: 0.1 },
  "gpt-4.1-nano": { in: 0.1, out: 0.4, cached: 0.025 },
  "gpt-4o": { in: 2.5, out: 10, cached: 1.25 },
  "gpt-4o-mini": { in: 0.15, out: 0.6, cached: 0.075 },
  "gpt-5": { in: 1.07, out: 8.5, cached: 0.107 },
  "gpt-5-mini": { in: 0.25, out: 2, cached: 0.025 },
  "gpt-5-nano": { in: 0.05, out: 0.4, cached: 0.005 },
  "gpt-5.1": { in: 1.07, out: 8.5, cached: 0.107 },
  "gpt-5.2": { in: 1.75, out: 14, cached: 0.175 },
  "gpt-5.4": { in: 2.5, out: 15, cached: 0.25 },
  "gpt-5.4-mini": { in: 0.75, out: 4.5, cached: 0.075 },
  "gpt-5.4-nano": { in: 0.2, out: 1.25, cached: 0.02 },
  "gpt-5.4-pro": { in: 30, out: 180, cached: 30 },
  "gpt-5.5": { in: 5, out: 30, cached: 0.5 },
  "gpt-5.5-pro": { in: 30, out: 180, cached: 30 },
  "gpt-5.6": { in: 4, out: 20, cached: 0.4 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2, cached: 0.02 },
  "gpt-5.6-terra": { in: 2, out: 12, cached: 0.2 },
  "gpt-5.6-sol": { in: 4, out: 20, cached: 0.4 },
  "gpt-6-sol": { in: 2, out: 10, cached: 0.2 },
  "gpt-6-luna": { in: 0.1, out: 0.5, cached: 0.01 },
  "gpt-6-astra": { in: 10, out: 50, cached: 1 },
  "gpt-6.1-sol": { in: 2, out: 10, cached: 0.1 },
  "gpt-6.1-terra": { in: 1, out: 5, cached: 0.05 },
  "gpt-6.2-sol": { in: 2, out: 10, cached: 0.1 },
  "gpt-6.2-astra": { in: 8, out: 40, cached: 0.4 },
  "gpt-5-pro": { in: 15, out: 120, cached: 0 },
  "gpt-5.2-pro": { in: 21, out: 168, cached: 0 },
  "gpt-5-codex": { in: 1.07, out: 8.5, cached: 0.107 },
  "gpt-5.1-codex": { in: 1.07, out: 8.5, cached: 0.107 },
  "gpt-5.1-codex-mini": { in: 0.25, out: 2, cached: 0.025 },
  "gpt-5.1-codex-max": { in: 1.25, out: 10, cached: 0.125 },
  "gpt-5.2-codex": { in: 1.75, out: 14, cached: 0.175 },
  "gpt-5.3-codex": { in: 1.75, out: 14, cached: 0.175 },
};

const RETIRED_PRICING = {};

function parsePricing(src) {
  const out = {};
  for (const entry of String(src).split(",")) {
    const e = entry.trim();
    if (!e) continue;
    const eq = e.indexOf("=");
    if (eq < 0) continue;
    const model = e.slice(0, eq).trim();
    const parts = e.slice(eq + 1).split("/").map((n) => Number(n));
    if (!model || parts.length < 2 || parts.some((n) => !Number.isFinite(n))) continue;
    out[model] = { in: parts[0], out: parts[1], cached: parts[2] ?? parts[0] };
  }
  return out;
}

const PRICING = { ...PRICING_DEFAULT, ...parsePricing(process.env.PRISM_PROXY_PRICING || "") };

// Rates above each model's input-token threshold.
const PRICING_TIERS = {
  "grok-4.7": { over: 200000, in: 4, out: 12, cached: 1 },
  "gpt-5.4": { over: 272000, in: 5, out: 22.5, cached: 0.5 },
  "gpt-5.4-pro": { over: 272000, in: 60, out: 270, cached: 60 },
  "gpt-5.5": { over: 272000, in: 10, out: 45, cached: 1 },
  "gpt-5.5-pro": { over: 272000, in: 60, out: 270, cached: 60 },
  "gpt-5.6": { over: 272000, in: 8, out: 30, cached: 0.8 },
  "gpt-5.6-sol": { over: 272000, in: 8, out: 30, cached: 0.8 },
  "gpt-5.6-terra": { over: 272000, in: 4, out: 18, cached: 0.4 },
  "gpt-5.6-luna": { over: 272000, in: 0.4, out: 1.8, cached: 0.04 },
  "gpt-6-sol": { over: 272000, in: 4, out: 15, cached: 0.4 },
  "gpt-6-luna": { over: 272000, in: 0.2, out: 0.75, cached: 0.02 },
  "gpt-6-astra": { over: 272000, in: 20, out: 75, cached: 2 },
  "gpt-6.1-sol": { over: 272000, in: 4, out: 15, cached: 0.2 },
  "gpt-6.1-terra": { over: 272000, in: 2, out: 7.5, cached: 0.1 },
  "gpt-6.2-sol": { over: 272000, in: 4, out: 15, cached: 0.2 },
  "gpt-6.2-astra": { over: 272000, in: 16, out: 60, cached: 0.8 },
};

// Dated variants inherit their base model's price (`gpt-6.2-sol-2026-11-17` ->
// `gpt-6.2-sol`), and a provider prefix is ignored (`doway/gpt-6.2-sol`).
function baseModelId(model) {
  let m = String(model || "");
  const slash = m.lastIndexOf("/");
  if (slash >= 0) m = m.slice(slash + 1);
  return m.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

// Cost of one record. Cached tokens are part of the prompt count and are billed
// at the cached-read rate instead of the full input rate.
function recordCost(r) {
  const base = baseModelId(r.m);
  let p = PRICING[r.m] || PRICING[base] || RETIRED_PRICING[r.m] || RETIRED_PRICING[base];
  if (!p) return 0;
  const tier = PRICING_TIERS[base];
  // Imported billing rows are totals over many requests, so their size says nothing
  // about any one request: they keep the flat rate.
  if (tier && !r.seed && (r.i || 0) > tier.over) p = tier;
  const cached = Math.min(r.c || 0, r.i || 0);
  const fresh = Math.max(0, (r.i || 0) - cached);
  let cost = fresh * p.in + cached * p.cached + (r.o || 0) * p.out;
  if (p.write) cost += (r.cacheWrite || 0) * (p.write - p.in) + (r.hourWrite || 0) * (2 * p.in - p.write);
  if (p.imageInput) {
    const cachedImage = r.cachedImage || 0;
    cost += ((r.imageInput || 0) - cachedImage) * (p.imageInput - p.in) + cachedImage * (p.imageCached - p.cached);
  }
  return cost / 1e6;
}

// Retries after an upstream 429 before the 429 is handed to the client.
const MAX_429_RETRIES = 6;
// Retry budget for failures other than an upstream HTTP 502.
const MAX_5XX_RETRIES = 5;
// Wall-clock ceiling for 429 waits on a single request.
const RATE_LIMIT_BUDGET_MS = Number(process.env.PRISM_PROXY_RL_BUDGET_MS) || 10 * 60 * 1000;
// Never trust a retry-after beyond this; a stuck upstream must not park a turn.
const RETRY_AFTER_CAP_MS = 120000;
// Log a line when a request had to wait this long for a slot.
const QUEUE_LOG_MS = 5000;

// ---- usage accounting -------------------------------------------------------
// Every completed chat request appends one compact record to a JSONL file and
// to an in-memory ring, so /usage can report 24h / 7d / 30d / all-time windows.
// Records are pruned at 30 days; lifetime totals live in the JSON snapshot.
const USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const usage = { since: Date.now(), records: [], lifetime: {}, loaded: false };

function loadUsage() {
  if (usage.loaded) return;
  usage.loaded = true;
  try {
    const snap = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    if (snap?.since) usage.since = snap.since;
    if (snap?.lifetime) usage.lifetime = snap.lifetime;
  } catch {}
  try {
    const cutoff = Date.now() - USAGE_RETENTION_MS;
    const lines = fs.readFileSync(USAGE_LOG, "utf8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.t >= cutoff) usage.records.push(r);
      } catch {}
    }
  } catch {}

  // Records written before the first-token method carry a generation time that
  // started at the first byte and ran to the end, and was divided by every output
  // token. Those rates are wrong, so the timing is dropped (tokens, requests and
  // cost stay). The new method always writes `sr`, which is how the two are told
  // apart, so this runs once and then finds nothing.
  let cleared = 0;
  for (const r of usage.records) {
    if (!r.seed && !("sr" in r) && r.gm) {
      delete r.gm;
      cleared++;
    }
  }
  if (cleared > 0) {
    for (const lt of Object.values(usage.lifetime)) if (lt) lt.genMs = 0;
    try {
      fs.writeFileSync(USAGE_LOG, usage.records.map((r) => JSON.stringify(r)).join("\n") + "\n");
      fs.writeFileSync(USAGE_FILE, JSON.stringify({ since: usage.since, lifetime: usage.lifetime }));
    } catch (e) {
      log(`could not rewrite usage log: ${e?.message || e}`);
    }
    log(`cleared the tok/s timing from ${cleared} record(s) measured by the old method`);
  }
}

let usageSaveTimer = null;
function saveUsageSoon() {
  if (usageSaveTimer) return;
  usageSaveTimer = setTimeout(() => {
    usageSaveTimer = null;
    if (retired) return;
    try {
      fs.writeFileSync(USAGE_FILE, JSON.stringify({ since: usage.since, lifetime: usage.lifetime }));
    } catch {}
  }, 2000);
  try { usageSaveTimer.unref?.(); } catch {}
}

function appendUsageRecord(rec) {
  usage.records.push(rec);
  try {
    try {
      if (fs.statSync(USAGE_LOG).size > USAGE_LOG_MAX_BYTES) fs.truncateSync(USAGE_LOG, 0);
    } catch {}
    fs.appendFileSync(USAGE_LOG, JSON.stringify(rec) + "\n");
  } catch {}
  const lt = (usage.lifetime[rec.m] = usage.lifetime[rec.m] || { requests: 0, input: 0, output: 0, reasoning: 0, cached: 0, genMs: 0 });
  lt.requests++;
  lt.input += rec.i || 0;
  lt.output += rec.o || 0;
  lt.reasoning += rec.r || 0;
  lt.cached += rec.c || 0;
  lt.genMs += rec.gm || 0;
  saveUsageSoon();
}

// Stored per request:
//   ttft - request sent -> first frame carrying model text (time to first token)
//   gm   - first -> last text frame (the generation window). Zero when there were
//          fewer than two text frames, which leaves the request out of tok/s.
//   ms   - total wall time, kept for latency only.
function recordUsage(model, result, ms, slot = 0, imageRequest = false) {
  if (!model || !result || result.status !== 200) return;
  const u = result.usage ?? parseUsageFromText(result.tail);
  if (!u && !imageRequest) return;
  const t = result.timing || {};
  const ttft = t.firstTokenAt && t.sentAt ? Math.max(0, t.firstTokenAt - t.sentAt) : 0;
  const gm = t.firstTokenAt && t.lastTokenAt && t.tokenFrames >= 2
    ? Math.max(0, t.lastTokenAt - t.firstTokenAt)
    : 0;
  appendUsageRecord({
    t: Date.now(),
    m: model,
    k: slot,
    i: u?.prompt ?? 0,
    o: u?.completion ?? 0,
    r: u?.reasoning ?? 0,
    c: u?.cached ?? 0,
    ...u?.details,
    gm,
    ttft,
    sr: t.sawReasoning ? 1 : 0,
    ms: Math.max(0, Math.round(ms)),
  });
  return u && u.prompt + u.completion;
}

function nativeUsage(u, messages) {
  if (!u || (u.input_tokens == null && u.output_tokens == null)) return null;
  if (messages) {
    const cached = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    return { prompt: (u.input_tokens ?? 0) + cached + cacheWrite, completion: u.output_tokens ?? 0, cached,
      details: { cacheWrite, hourWrite: u.cache_creation?.ephemeral_1h_input_tokens ?? 0 } };
  }
  const input = u.input_tokens_details ?? {};
  return { prompt: u.input_tokens ?? 0, completion: u.output_tokens ?? 0, cached: input.cached_tokens ?? 0,
    details: { imageInput: input.image_tokens ?? 0, cachedImage: input.cached_tokens_details?.image_tokens ?? 0 } };
}

function captureNativeUsage(stream, isEventStream, messages) {
  let usage;
  const collect = (text) => {
    try {
      const event = JSON.parse(text);
      const counts = event.type === "message_start" ? event.message?.usage : event.usage;
      if (counts) usage = { ...usage, ...Object.fromEntries(Object.entries(counts).filter(([, value]) => value != null)) };
    } catch {}
  };
  if (isEventStream) {
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (line.startsWith("data:") && line.includes('"usage"')) collect(line.slice(5));
    });
    lines.on("error", () => lines.close());
  } else {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => collect(Buffer.concat(chunks).toString("utf8")));
  }
  return () => nativeUsage(usage, messages);
}

function parseUsageFromText(text) {
  if (!text) return null;
  const num = (key) => {
    const re = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "g");
    let last = null, m;
    while ((m = re.exec(text))) last = Number(m[1]);
    return last;
  };
  // Chat completions use prompt_tokens/completion_tokens; the Responses API
  // uses input_tokens/output_tokens.
  const prompt = num("prompt_tokens") ?? num("input_tokens");
  const completion = num("completion_tokens") ?? num("output_tokens");
  if (prompt == null && completion == null) return null;
  return {
    prompt: prompt || 0,
    completion: completion || 0,
    reasoning: num("reasoning_tokens") || 0,
    cached: num("cached_tokens") || 0,
  };
}

function pruneUsage() {
  const cutoff = Date.now() - USAGE_RETENTION_MS;
  if (usage.records.length === 0) return;
  let i = 0;
  while (i < usage.records.length && usage.records[i].t < cutoff) i++;
  if (i > 0) usage.records.splice(0, i);
}

// Requests shorter than this are left out of tok/s: a handful of tokens over a few
// milliseconds is dominated by network framing, not by the model's decode speed.
const MIN_TPS_TOKENS = 16;
const MIN_TPS_WINDOW_MS = 250;

// slot: only records that were served on that key (1-based); undefined = all keys.
function windowStats(model, since, slot) {
  const acc = { requests: 0, input: 0, output: 0, reasoning: 0, cached: 0, seeded: 0, cost: 0 };
  let realMs = 0, realReq = 0;
  let realIn = 0, realCache = 0;
  let tpsTokens = 0, tpsMs = 0, tpsN = 0;
  let ttftSum = 0, ttftN = 0;
  const rates = [];
  let lastRate = 0;
  for (const r of usage.records) {
    if (r.t < since) continue;
    if (model && r.m !== model) continue;
    // Totals leave out retired models, so the overview shows only what is offered.
    // Their records stay in the log and can still be read per model.
    if (!model && RETIRED_PRICING[r.m]) continue;
    if (slot !== undefined && (r.k || 0) !== slot) continue;
    acc.requests += r.n || 1;
    acc.input += r.i || 0;
    acc.output += r.o || 0;
    acc.reasoning += r.r || 0;
    acc.cached += r.c || 0;
    acc.cost += recordCost(r);
    if (r.seed) {
      // Imported aggregate: real token counts, no timing to average.
      acc.seeded++;
      continue;
    }
    realReq++;
    realMs += r.ms || 0;
    realIn += r.i || 0;
    realCache += r.c || 0;

    if (r.ttft > 0) { ttftSum += r.ttft; ttftN++; }

    // Decode speed: tokens produced after the first one, over the span between
    // the first and last text frame. Reasoning that was never streamed happened
    // before the first frame, so it is taken out of the count.
    if (r.gm >= MIN_TPS_WINDOW_MS) {
      const hidden = r.r > 0 && !r.sr ? r.r : 0;
      const n = (r.o || 0) - hidden - 1;
      if (n >= MIN_TPS_TOKENS) {
        tpsTokens += n;
        tpsMs += r.gm;
        tpsN++;
        lastRate = n / (r.gm / 1000);
        rates.push(lastRate);
      }
    }
  }
  acc.cost = +acc.cost.toFixed(6);
  // Token-weighted: total tokens over total time, so a long answer counts for
  // more than a short one.
  acc.avgTps = tpsMs > 0 ? +(tpsTokens / (tpsMs / 1000)).toFixed(1) : 0;
  // The plain mean of each request's own rate, the latest request's rate, and the
  // median: all reported so the tooltip can show how the figure was reached.
  acc.meanTps = rates.length ? +(rates.reduce((s, v) => s + v, 0) / rates.length).toFixed(1) : 0;
  acc.lastTps = +lastRate.toFixed(1);
  rates.sort((a, b) => a - b);
  acc.medTps = rates.length ? +rates[Math.floor(rates.length / 2)].toFixed(1) : 0;
  acc.tpsN = tpsN;
  acc.ttftMs = ttftN > 0 ? Math.round(ttftSum / ttftN) : 0;
  acc.ttftN = ttftN;
  acc.avgMs = realReq > 0 ? Math.round(realMs / realReq) : 0;
  // Cached share of the prompt. Prompt tokens already include the cached ones.
  // Imported history has no cache data, so only requests the proxy carried count.
  acc.cachedReal = realCache;
  acc.inputReal = realIn;
  acc.cachedPct = realIn > 0 ? +((realCache / realIn) * 100).toFixed(1) : 0;
  return acc;
}

function usageReport() {
  pruneUsage();
  const now = Date.now();
  const d = new Date(now);
  const windows = {
    // 24u is UTC midnight to now; 24h is the rolling last 24 hours.
    "24u": Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    "24h": now - 24 * 60 * 60 * 1000,
    "7d": now - 7 * 24 * 60 * 60 * 1000,
    "30d": now - 30 * 24 * 60 * 60 * 1000,
    all: 0,
  };
  const out = { since: usage.since, updated: now, pricing: PRICING, windows: {}, models: {} };
  for (const [key, since] of Object.entries(windows)) {
    out.windows[key] = windowStats(null, since);
    out.models[key] = {};
    const names = new Set(usage.records.filter((r) => r.t >= since).map((r) => r.m));
    for (const m of names) out.models[key][m] = windowStats(m, since);
  }
  // all-time also includes records pruned from disk, via the lifetime snapshot
  // Per key, so each key's own spend and traffic can be read. The panel shows the
  // combined `windows` and `models`; this is for looking at one key.
  out.perKey = {};
  for (const [key, since] of Object.entries(windows)) {
    const slots = new Set(usage.records.filter((r) => r.t >= since).map((r) => r.k || 0));
    out.perKey[key] = {};
    for (const k of slots) {
      const models = {};
      const names = new Set(usage.records.filter((r) => r.t >= since && (r.k || 0) === k).map((r) => r.m));
      for (const m of names) models[m] = windowStats(m, since, k);
      out.perKey[key][k] = { total: windowStats(null, since, k), models };
    }
  }
  out.lifetime = usage.lifetime;
  return out;
}

const LOG_FILE = path.join(HOME_DIR, ".prism-proxy.log");
const USAGE_FILE = path.join(HOME_DIR, ".prism-usage.json");
const USAGE_LOG = path.join(HOME_DIR, ".prism-usage.jsonl");
const USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

function log(msg) {
  const line = `${new Date().toISOString()} ${TAG} ${msg}`;
  console.log(line);
  try {
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.truncateSync(LOG_FILE, 0);
    } catch {}
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

async function waitForRetry(ms, signal) {
  try { await delay(ms, undefined, { signal }); }
  catch (err) { if (!signal?.aborted) throw err; }
}

// ---- limit parsing ---------------------------------------------------------

function parseWindow(spec) {
  const m = /^(\d+)\s*(ms|s|m|h)?$/i.exec(String(spec).trim());
  if (!m) return null;
  const unit = (m[2] || "s").toLowerCase();
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
}

function parseLimits(src) {
  const out = new Map();
  for (const part of String(src).split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.lastIndexOf("=");
    if (eq < 0) continue;
    const model = entry.slice(0, eq).trim();
    const spec = entry.slice(eq + 1).trim();
    const slash = spec.indexOf("/");
    if (!model || slash < 0) continue;
    const max = Number(spec.slice(0, slash));
    const windowMs = parseWindow(spec.slice(slash + 1));
    if (!Number.isFinite(max) || !windowMs) {
      log(`ignoring malformed limit entry "${entry}"`);
      continue;
    }
    out.set(model, { max, windowMs });
  }
  return out;
}

const LIMITS = parseLimits(process.env.PRISM_PROXY_LIMITS || LIMITS_DEFAULT);
const TOKEN_LIMITS = parseLimits(process.env.PRISM_PROXY_TOKEN_LIMITS || TOKEN_LIMITS_DEFAULT);
const LIMIT_FALLBACK = LIMITS.get("*") || null;
const TOKEN_FALLBACK = TOKEN_LIMITS.get("*") || null;
const GLOBAL_LIMITS = parseLimits(process.env.PRISM_PROXY_GLOBAL_LIMITS || GLOBAL_LIMITS_DEFAULT);
const GLOBAL_TOKEN_LIMITS = parseLimits(process.env.PRISM_PROXY_GLOBAL_TOKEN_LIMITS || GLOBAL_TOKEN_LIMITS_DEFAULT);
const GLOBAL_LIMIT = GLOBAL_LIMITS.get("global") || GLOBAL_LIMITS.get("*") || null;
const GLOBAL_TOKEN_LIMIT = GLOBAL_TOKEN_LIMITS.get("global") || GLOBAL_TOKEN_LIMITS.get("*") || null;

class ModelLimiter {
  constructor(model, max, windowMs, tokenMax, tokenWindowMs) {
    this.model = model;
    this.max = max;
    this.windowMs = windowMs;
    this.tokenMax = tokenMax;
    this.tokenWindowMs = tokenWindowMs;
    this.stamps = [];              // dispatch times inside the window
    this.tokens = [];              // { t, n } token reservations inside the window
    this.blockedUntil = 0;         // set by an upstream 429
    this.tail = Promise.resolve(); // FIFO reservation chain
    this.total = 0;
    this.throttled = 0;
    this.retries = 0;
    this.shed = 0;                 // times a caller waited on the token budget
  }

  prune(now) {
    const cutoff = now - this.windowMs;
    while (this.stamps.length && this.stamps[0] <= cutoff) this.stamps.shift();
    if (this.tokenMax > 0) {
      const tc = now - this.tokenWindowMs;
      while (this.tokens.length && this.tokens[0].t <= tc) this.tokens.shift();
    }
  }

  tokenSum() {
    let n = 0;
    for (const e of this.tokens) n += e.n;
    return n;
  }

  // milliseconds the caller must wait; 0 means a slot is free now
  waitTime(now, estTokens = 0) {
    this.prune(now);
    if (this.blockedUntil > now) return this.blockedUntil - now;
    if (this.max > 0 && this.stamps.length >= this.max) {
      return this.stamps[0] + this.windowMs - now;
    }
    if (this.tokenMax > 0 && estTokens > 0) {
      // A single request can exceed the whole budget (a huge compaction
      // prompt). It must still be admitted, or it would wait forever: clamp
      // the estimate to the budget and only queue behind existing traffic.
      const est = Math.min(estTokens, this.tokenMax);
      const used = this.tokenSum();
      if (used + est > this.tokenMax) {
        // wait until enough of the oldest reservations age out
        let need = used + est - this.tokenMax;
        let acc = 0;
        for (const e of this.tokens) {
          acc += e.n;
          if (acc >= need) return e.t + this.tokenWindowMs - now;
        }
        return this.tokenWindowMs;
      }
    }
    return 0;
  }

  reserve(now, estTokens) {
    this.prune(now);
    if (this.max > 0) {
      this.stamps.push(now);
      this.total++;
    }
    let entry = null;
    if (this.tokenMax > 0 && estTokens > 0) {
      entry = { t: now, n: Math.min(estTokens, this.tokenMax) };
      this.tokens.push(entry);
    }
    return entry;
  }

  // Replace a reservation's estimate with what the request actually used.
  reconcile(entry, actualTokens) {
    if (!entry || !Number.isFinite(actualTokens) || actualTokens < 0) return;
    entry.n = Math.round(actualTokens);
  }

  blockFor(ms, now) {
    this.blockedUntil = Math.max(this.blockedUntil, now + ms);
  }

  snapshot(now) {
    this.prune(now);
    return {
      max: this.max,
      windowMs: this.windowMs,
      used: this.stamps.length,
      tokenMax: this.tokenMax,
      tokenWindowMs: this.tokenWindowMs,
      tokensUsed: this.tokenSum(),
      blockedMs: Math.max(0, this.blockedUntil - now),
      total: this.total,
      throttled: this.throttled,
      retries: this.retries,
      shed: this.shed,
    };
  }
}

const limiters = new Map();
const globalLimiters = new Map();

function limiterFor(model, slot = 0) {
  if (!model) return null;
  // Each key has its own per-model windows, so the limiter is keyed by both.
  const mapKey = slot ? `${slot}|${model}` : model;
  let lim = limiters.get(mapKey);
  if (lim) return lim;
  const cfg = LIMITS.get(model) || LIMIT_FALLBACK;
  const tok = TOKEN_LIMITS.get(model) || TOKEN_FALLBACK;
  const max = cfg ? cfg.max : 0;
  const tokenMax = tok ? tok.max : 0;
  if (max <= 0 && tokenMax <= 0) return null;
  lim = new ModelLimiter(
    model,
    max,
    cfg ? cfg.windowMs : 60000,
    tokenMax,
    tok ? tok.windowMs : 60000,
  );
  limiters.set(mapKey, lim);
  return lim;
}

function globalLimiterFor(slot = 0) {
  if (!GLOBAL_LIMIT && !GLOBAL_TOKEN_LIMIT) return null;
  const mapKey = slot ? `global|${slot}` : "global";
  let lim = globalLimiters.get(mapKey);
  if (lim) return lim;
  lim = new ModelLimiter(
    "global",
    GLOBAL_LIMIT ? GLOBAL_LIMIT.max : 0,
    GLOBAL_LIMIT ? GLOBAL_LIMIT.windowMs : 60000,
    GLOBAL_TOKEN_LIMIT ? GLOBAL_TOKEN_LIMIT.max : 0,
    GLOBAL_TOKEN_LIMIT ? GLOBAL_TOKEN_LIMIT.windowMs : 60000,
  );
  globalLimiters.set(mapKey, lim);
  log(`global limiter ${mapKey} created (${lim.max}/${lim.windowMs / 1000}s, ${lim.tokenMax} tokens/${lim.tokenWindowMs / 1000}s)`);
  return lim;
}

function hasLimiter(model, slot = 0) {
  return !!(globalLimiterFor(slot) || limiterFor(model, slot));
}

// Strict FIFO: each caller awaits the previous reservation. Reservation is
// instant, so this serializes slots rather than requests.
//
// With `maxWaitMs`, a caller gives up its place instead of waiting longer than
// that and resolves `{ spill: true }` without reserving anything, so the caller
// can send the request somewhere else (see the overflow rules below).
function acquireLimiter(lim, label, estTokens = 0, maxWaitMs = 0, signal) {
  if (!lim) return Promise.resolve(null);
  const calledAt = Date.now();
  let cancelled = false;
  const run = lim.tail.then(async () => {
    if (cancelled) return { spill: true };
    const start = Date.now();
    for (;;) {
      if (signal?.aborted) return null;
      if (cancelled) return { spill: true };
      const now = Date.now();
      const wait = lim.waitTime(now, estTokens);
      if (wait > 0 && maxWaitMs > 0 && now + wait - calledAt > maxWaitMs) {
        cancelled = true;
        return { spill: true };
      }
      if (wait <= 0) {
        const entry = lim.reserve(now, estTokens);
        const waited = now - start;
        if (waited > 0) {
          lim.throttled++;
          if (waited > QUEUE_LOG_MS) {
            log(`throttled ${label} for ${(waited / 1000).toFixed(1)}s (${lim.max}/${lim.windowMs / 1000}s` +
              `${lim.tokenMax > 0 ? `, ${lim.tokenSum()}/${lim.tokenMax} tokens` : ""})`);
          }
        }
        return { limiter: lim, entry };
      }
      await waitForRetry(Math.min(wait, 1000), signal);
    }
  });
  lim.tail = run.catch(() => {});
  if (!maxWaitMs) return run;
  // Also leave the queue at the deadline even when whoever is ahead of us is
  // still waiting, so one slow caller cannot hold the others past their limit.
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cancelled = true; resolve({ spill: true }); }, maxWaitMs);
    run.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve({ spill: true }); });
  });
}

// Every request takes a slot in the key's global window first, then in its
// per-model window when one is configured. The returned reservation keeps both
// entries so usage reconciliation updates both budgets.
function acquire(model, estTokens = 0, maxWaitMs = 0, slot = 0, signal) {
  const global = globalLimiterFor(slot);
  const modelLim = limiterFor(model, slot);
  if (!global && !modelLim) return Promise.resolve(null);
  return (async () => {
    const globalRes = await acquireLimiter(global, "global", estTokens, maxWaitMs, signal);
    if (signal?.aborted) return null;
    if (globalRes && globalRes.spill) return globalRes;
    const modelRes = await acquireLimiter(modelLim, model, estTokens, maxWaitMs, signal);
    if (signal?.aborted) return null;
    if (modelRes && modelRes.spill) return modelRes;
    return {
      limiter: global || modelLim,
      entry: (globalRes && globalRes.entry) || (modelRes && modelRes.entry) || null,
      global: globalRes,
      model: modelRes,
    };
  })();
}

// ---- overflow spill ---------------------------------------------------------
// A model that is saturated makes every extra request wait for a slot. With a
// rule, a request that would wait longer than the threshold is sent to a
// fallback model instead of queueing.
// Format (PRISM_PROXY_OVERFLOW): "gpt-6.2-astra=gpt-6.2-sol:20s,other=target:5s".
// Off by default: it swaps the model mid-conversation, so it is opt-in.
const OVERFLOW_DEFAULT_WAIT_MS = 20000;

function parseOverflow(src) {
  const out = new Map();
  for (const part of String(src).split(",")) {
    const e = part.trim();
    if (!e) continue;
    const eq = e.indexOf("=");
    if (eq < 0) continue;
    const from = e.slice(0, eq).trim();
    const [to, wait] = e.slice(eq + 1).split(":").map((s) => s.trim());
    const maxWaitMs = wait ? parseWindow(wait) : OVERFLOW_DEFAULT_WAIT_MS;
    if (!from || !to || from === to || !maxWaitMs) {
      log(`ignoring malformed overflow rule "${e}"`);
      continue;
    }
    out.set(from, { to, maxWaitMs });
  }
  return out;
}

const OVERFLOW = parseOverflow(process.env.PRISM_PROXY_OVERFLOW || "");
const overflowStats = new Map(); // from -> { to, count }
// Overflow traffic that is in flight right now: target -> { count, from: Set }.
// The panel marks those models with a * while they are serving someone else's
// requests.
const overflowActive = new Map();

// Spills that landed on a target within the last rate window. A spilled request
// is often over in seconds, so "in flight" alone would make the * flicker; the
// window count says how many of the slots the target shows as used came from
// another model's overflow.
const OVERFLOW_RECENT_MS = 60000;
const overflowRecent = new Map(); // target -> [{ t, from }]

function overflowReport(now) {
  const out = {};
  for (const [target, list] of overflowRecent) {
    const keep = list.filter((x) => now - x.t < OVERFLOW_RECENT_MS);
    if (keep.length) overflowRecent.set(target, keep); else overflowRecent.delete(target);
  }
  const targets = new Set([...overflowRecent.keys(), ...overflowActive.keys()]);
  for (const target of targets) {
    const recent = overflowRecent.get(target) || [];
    const live = overflowActive.get(target);
    out[target] = {
      count: Math.max(recent.length, live ? live.count : 0),
      inFlight: live ? live.count : 0,
      from: [...new Set([...recent.map((x) => x.from), ...(live ? live.from : [])])],
    };
  }
  return out;
}

function markOverflowActive(target, from) {
  const list = overflowRecent.get(target) || [];
  list.push({ t: Date.now(), from });
  overflowRecent.set(target, list);
  const e = overflowActive.get(target) || { count: 0, from: new Set() };
  e.count++;
  e.from.add(from);
  overflowActive.set(target, e);
}

function clearOverflowActive(target, from) {
  const e = overflowActive.get(target);
  if (!e) return;
  e.count = Math.max(0, e.count - 1);
  if (e.count === 0) {
    e.from.delete(from);
    if (e.from.size === 0) overflowActive.delete(target);
  }
}

// ---- key pool ---------------------------------------------------------------
// The gateway meters each key separately, so a second key means a second set of
// per-model windows. Keys are added from the panel and stored next to the
// plugin. One session is one key: it is pinned on first sight to the key with the
// fewest sessions, and every request it makes is charged to that key's windows
// and no other. There is no round-robin.
// PRISM_PROXY_KEYS_FILE moves the file (the tests use a throwaway one).
const KEYS_FILE = process.env.PRISM_PROXY_KEYS_FILE ||
  path.join(HOME_DIR, "keys.json");
// The file used to be hidden; it is moved to keys.json on first start.
const LEGACY_KEYS_FILE = path.join(HOME_DIR, ".prism-keys.json");
const MAX_KEYS = 8;
const CORS_HEADERS = { "cache-control": "no-store", "access-control-allow-origin": "*" };
let keyPool = [];
let keyCursor = 0;
// sessionId -> 1-based key slot. A session is glued to one key: its requests
// follow that key's windows, and a second session on another key has its own.
const sessionKeyPins = new Map();
// A session counts toward its key's load only while it is live: seen within the
// last half hour. Pins of sessions that stopped long ago must not push new ones
// away from a key that is actually idle. Pins are forgotten after two weeks.
const SESSION_LIVE_MS = 30 * 60 * 1000;
const SESSION_PIN_TTL_MS = 14 * 24 * 60 * 60 * 1000;
// sessionId -> { last, active, requests, model }. `last` is persisted so a
// restart does not make every live session look dead.
const sessionActivity = new Map();

function touchSession(sid, model) {
  const a = sessionActivity.get(sid) || { last: 0, active: 0, requests: 0, model: null, spilledFrom: null };
  a.last = Date.now();
  a.requests++;
  if (model) a.model = model;
  a.spilledFrom = null; // a spill only lasts for the request that made it
  sessionActivity.set(sid, a);
  saveKeysSoon();
  return a;
}

// Remember that this session took a request slot on `model` now, so the panel can
// show how much of its key's per-minute cap the session is using.
function noteSessionSlot(a, model, reservation) {
  if (!a || !model) return;
  const now = Date.now();
  a.slots = (a.slots || []).filter((x) => now - x.t < 5 * 60 * 1000);
  // `entry` is the limiter's own token record, so the figure follows the
  // reconciliation to the real token count once the request finishes.
  a.slots.push({ t: now, model, entry: reservation ? reservation.entry : null });
}

let keysSaveTimer = null;
function saveKeysSoon() {
  if (keysSaveTimer) return;
  keysSaveTimer = setTimeout(() => { keysSaveTimer = null; saveKeys(); }, 30000);
  try { keysSaveTimer.unref?.(); } catch {}
}

// After key `removed` (1-based) is deleted, later keys shift down one slot. Pins
// follow their key rather than their number, so a session never silently moves
// onto a different credential; sessions that were on the removed key are
// reassigned on their next request.
function remapPinsAfterRemoval(removed) {
  for (const [sid, slot] of [...sessionKeyPins]) {
    if (slot === removed) sessionKeyPins.delete(sid);
    else if (slot > removed) sessionKeyPins.set(sid, slot - 1);
  }
}

function loadKeys() {
  let fromFile = [];
  let migrate = false;
  let source = KEYS_FILE;
  if (!fs.existsSync(KEYS_FILE) && fs.existsSync(LEGACY_KEYS_FILE)) {
    source = LEGACY_KEYS_FILE;
    migrate = true;
  }
  try {
    const j = JSON.parse(fs.readFileSync(source, "utf8"));
    if (Array.isArray(j.keys)) fromFile = j.keys;
    if (j && typeof j.pins === "object" && j.pins) {
      for (const [sid, slot] of Object.entries(j.pins)) {
        if (typeof sid === "string" && Number.isInteger(slot)) sessionKeyPins.set(sid, slot);
      }
    }
    if (j && typeof j.seen === "object" && j.seen) {
      for (const [sid, ts] of Object.entries(j.seen)) {
        if (Number.isFinite(ts)) sessionActivity.set(sid, { last: ts, active: 0, requests: 0, model: null });
      }
    }
  } catch {}
  {
    const now = Date.now();
    for (const sid of [...sessionKeyPins.keys()]) {
      const a = sessionActivity.get(sid);
      if (!a) {
        // pinned by an older file with no timestamp: keep it, but not as live
        sessionActivity.set(sid, { last: now - SESSION_LIVE_MS - 1, active: 0, requests: 0, model: null });
      } else if (now - a.last > SESSION_PIN_TTL_MS) {
        sessionKeyPins.delete(sid);
        sessionActivity.delete(sid);
      }
    }
  }
  const fromEnv = String(process.env.PRISM_PROXY_KEYS || "").split(",");
  keyPool = [...new Set([...fromEnv, ...fromFile].map((k) => String(k || "").trim()).filter(Boolean))].slice(0, MAX_KEYS);

  if (migrate) {
    saveKeys();
    if (fs.existsSync(KEYS_FILE)) {
      try { fs.unlinkSync(LEGACY_KEYS_FILE); } catch {}
      log(`moved ${path.basename(LEGACY_KEYS_FILE)} -> ${path.basename(KEYS_FILE)} (${keyPool.length} key(s) kept)`);
    }
  }
}

function saveKeys() {
  if (retired) return;
  try {
    const pins = {};
    const seen = {};
    for (const [sid, slot] of sessionKeyPins) {
      pins[sid] = slot;
      const a = sessionActivity.get(sid);
      if (a && a.last) seen[sid] = a.last;
    }
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys: keyPool, pins, seen }, null, 2) + "\n", "utf8");
    try { fs.chmodSync(KEYS_FILE, 0o600); } catch {}
  } catch (e) {
    log(`could not save keys: ${e?.message || e}`);
  }
}

function maskKey(k) {
  const s = String(k || "");
  return s.length <= 4 ? "…" : "…" + s.slice(-4);
}

// Which key slot a session uses: an explicit pin, or the least-pinned slot,
// which is then remembered so the session stays on it for good.
function keySlotForSession(sessionId) {
  if (keyPool.length === 0) return 0;
  if (!sessionId) return 1;

  const pinned = sessionKeyPins.get(sessionId);
  if (Number.isInteger(pinned) && pinned >= 1 && pinned <= keyPool.length) return pinned;

  // Only live sessions count: one that stopped hours ago is not load.
  const counts = liveSessionCounts();
  const slot = counts.indexOf(Math.min(...counts)) + 1;
  sessionKeyPins.set(sessionId, slot);
  // Clear the slot history: the old slots were on a different key's limiter, so
  // they do not count toward the new key's windows.
  const a = sessionActivity.get(sessionId);
  if (a) a.slots = [];
  saveKeys();
  return slot;
}

function liveSessionCounts() {
  const counts = new Array(keyPool.length).fill(0);
  const now = Date.now();
  for (const [sid, slot] of sessionKeyPins) {
    const a = sessionActivity.get(sid);
    if (!a || now - a.last > SESSION_LIVE_MS) continue;
    if (Number.isInteger(slot) && slot >= 1 && slot <= keyPool.length) counts[slot - 1]++;
  }
  return counts;
}

function pickKey(sessionId) {
  const slot = keySlotForSession(sessionId);
  if (slot >= 1 && slot <= keyPool.length) return keyPool[slot - 1];
  return keyPool[0] || null;
}

function keysReport() {
  const now = Date.now();
  const pins = {};
  for (const [sid, slot] of sessionKeyPins) pins[sid] = slot;
  const live = liveSessionCounts();

  // Sessions seen recently, with the key each one is glued to. Active ones
  // (a request in flight) first, then most recently used.
  const sessions = [];
  for (const [id, a] of sessionActivity) {
    if (now - a.last > SESSION_LIVE_MS) continue;
    const slot = sessionKeyPins.get(id) || 0;
    // How much of the key's request cap on this model the session itself used in
    // the current window, next to what every session on that key used together.
    let limit = null;
    const lim = slot ? (globalLimiterFor(slot) || (a.model ? limiterFor(a.model, slot) : null)) : null;
    if (lim && (lim.max > 0 || lim.tokenMax > 0)) {
      const snap = lim.snapshot(now);
      // A session can run on different models. Each slot records the model it was
      // for, so count only the slots on this model, in its window.
      const mine = (a.slots || []).filter((x) => x.model === a.model && now - x.t < snap.windowMs);
      const myTokens = (a.slots || [])
        .filter((x) => x.model === a.model && x.entry && now - x.t < snap.tokenWindowMs)
        .reduce((n, x) => n + (x.entry.n || 0), 0);
      limit = {
        used: Math.min(mine.length, snap.max), max: snap.max, keyUsed: snap.used, windowMs: snap.windowMs,
        tokens: myTokens, tokenMax: snap.tokenMax, keyTokens: snap.tokensUsed, tokenWindowMs: snap.tokenWindowMs,
      };
    }
    sessions.push({
      id,
      key: slot,
      limit,
      active: a.active,
      requests: a.requests,
      model: a.model,
      from: a.spilledFrom || null,
      idleMs: Math.max(0, now - a.last),
    });
  }
  sessions.sort((x, y) => (y.active > 0) - (x.active > 0) || x.idleMs - y.idleMs);

  return {
    keys: keyPool.map((k, i) => ({ index: i + 1, hint: maskKey(k), sessions: live[i] || 0 })),
    pins,
    sessions,
    max: MAX_KEYS,
    file: KEYS_FILE,
  };
}

// ---- manual model ping -----------------------------------------------------
// POST /ping sends one tiny prompt to each model, so the panel can show which
// model is alive and what it calls itself. Pings obey the same limiters as real
// traffic, requests and tokens both: a ping waits for a free slot instead of
// jumping the queue, and it is only skipped if the wait would outlast any window
// (three minutes).
const PING_PROMPT = "State the model you are and reply in exactly this form: I run <model name>, pong";
const PING_TIMEOUT_MS = Number(process.env.PRISM_PROXY_PING_TIMEOUT_MS) || 30000;
// The slot wait shares the same deadline: a ping returns within PING_TIMEOUT_MS
// whether it was waiting for a limiter slot or for the upstream reply.
const PING_MAX_WAIT_MS = Math.min(Number(process.env.PRISM_PROXY_PING_WAIT_MS) || 180000, PING_TIMEOUT_MS);
let lastAuthHeader = null; // most recent gateway credential seen on a real request

async function pingModel(model, auth, pingSlot = 0) {
  const started = Date.now();
  const endpoint = ROOT_MODELS.get(model) ?? "/chat/completions";
  if (endpoint === "/images/generations") return { model, ok: false, skipped: true, ms: 0, error: "Image model; no chat ping" };
  // Include the reply budget so the token reservation cannot push a window over
  // its cap: the limiter sees prompt + max_tokens up front.
  const estTokens = Math.ceil((PING_PROMPT.length + 64) / 4) + 60;
  // A ping is not a session. Run it on the key with the fewest live sessions
  // so it does not compete with real traffic on a busy key.
  const slot = pingSlot || (keyPool.length ? 1 : 0);
  const lim = globalLimiterFor(slot) || limiterFor(model, slot);
  let reservation = null;
  let queueMs = 0;

  if (lim) {
    PROXY_STATE.queued++;
    try { reservation = await acquire(model, estTokens, PING_MAX_WAIT_MS, slot); } finally { PROXY_STATE.queued--; }
    queueMs = Date.now() - started;
    if (reservation && reservation.spill) {
      const waitMs = lim.waitTime(Date.now(), estTokens);
      return { model, ok: false, skipped: true, queueMs, ms: Date.now() - started, error: `no free slot within ${Math.round(PING_MAX_WAIT_MS / 1000)}s, next in ${Math.ceil(waitMs / 1000)}s` };
    }
  }

  try {
    const payload = { model, stream: false, max_tokens: 60, messages: [{ role: "user", content: PING_PROMPT }] };
    const headers = { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) };
    if (endpoint === "/messages") headers["anthropic-version"] = "2023-06-01";
    const res = await postJson(endpoint, headers, payload, Math.max(1000, PING_TIMEOUT_MS - queueMs));
    const ms = Date.now() - started;
    if (res.status >= 400) {
      return { model, ok: false, queueMs, ms, error: `HTTP ${res.status}: ${res.text.replace(/\s+/g, " ").slice(0, 140)}` };
    }
    const j = JSON.parse(res.text);
    const messages = endpoint === "/messages";
    const text = messages ? (j.content || []).filter((part) => part.type === "text").map((part) => part.text).join("").trim()
      : (j?.choices?.[0]?.message?.content || "").trim();
    const tokens = recordUsage(model, { status: res.status, tail: res.text, usage: messages ? nativeUsage(j.usage, true) : null }, ms - queueMs, slot);
    reconcileTokens(reservation, tokens ?? estTokens, tokens == null ? Buffer.byteLength(res.text) : 0);
    return { model, ok: true, queueMs, ms, text };
  } catch (e) {
    return { model, ok: false, queueMs, ms: Date.now() - started, error: String(e?.message || e) };
  }
}

// One limiter per model, so the models are pinged concurrently and a busy model
// only delays its own row. All pings share the key with the least current
// concurrent usage: fewest requests in flight on its sessions, then fewest live
// sessions. A ping therefore never competes with an active turn on a busy key.
async function pingModels(models, fallbackAuth) {
  const now = Date.now();
  const load = Array.from({ length: keyPool.length }, () => ({ active: 0, live: 0 }));
  for (const [sid, slot] of sessionKeyPins) {
    if (slot < 1 || slot > keyPool.length) continue;
    const a = sessionActivity.get(sid);
    if (!a || now - a.last > SESSION_LIVE_MS) continue;
    load[slot - 1].live++;
    load[slot - 1].active += a.active || 0;
  }
  let slot = 0;
  if (keyPool.length) {
    slot = 1;
    for (let i = 1; i < load.length; i++) {
      if (load[i].active < load[slot - 1].active ||
          (load[i].active === load[slot - 1].active && load[i].live < load[slot - 1].live)) slot = i + 1;
    }
  }
  const auth = slot ? `Bearer ${keyPool[slot - 1]}` : fallbackAuth;
  log(`ping using key ${slot || "-"} (${load.map((l) => `${l.active} active/${l.live} live`).join(", ") || "no keys"})`);
  return Promise.all(models.map((m) => pingModel(m, auth, slot)));
}

// ---- vision handoff --------------------------------------------------------
// A text-only target that receives image parts cannot see them. Each image is
// captioned with the vision model, the image part is replaced by the caption
// text, and the request continues to the ORIGINAL model. Captions are cached by
// image hash, so a screenshot resent on a later turn costs nothing.
const VISION_MODEL_DEFAULT = "gpt-5.4-nano";
// The doway models accept images natively, so no model is captioned by default.
// Captioning throws the pixels away, which breaks anything that needs the actual
// image. List a model here only if it really cannot see. A rejected image
// request still falls back to captions automatically.
const VISION_TARGETS_DEFAULT = "";
const VISION_PROMPT_DEFAULT =
  "Describe this image in full detail for a text-only assistant that cannot see it. " +
  "Transcribe all text, code, UI labels, error messages, tables and diagrams exactly. " +
  "Be complete but concise.";
const VISION_CACHE_TTL_MS = 60 * 60 * 1000;
const VISION_CACHE_MAX = 200;
const VISION_ENABLED = !/^(0|false|off)$/i.test(process.env.PRISM_PROXY_VISION || "");
const VISION_MODEL = process.env.PRISM_PROXY_VISION_MODEL || VISION_MODEL_DEFAULT;
const VISION_TARGETS = (process.env.PRISM_PROXY_VISION_TARGETS || VISION_TARGETS_DEFAULT)
  .split(",").map((s) => s.trim()).filter(Boolean);
const VISION_PROMPT = process.env.PRISM_PROXY_VISION_PROMPT || VISION_PROMPT_DEFAULT;
const visionCache = new Map();

// ---- compaction handling ---------------------------------------------------
// Compaction is the one request whose failure kills the whole turn: OpenCode
// maps a content-filter finish to "Compaction summary was blocked by the
// provider" and gives up. Compaction is a single big request that carries no
// tools, so it is both easy to recognise and worth protecting:
//   - it waits until no other request is in flight (no quota contention);
//   - if the provider blocks it (content filter, error, unknown finish, 4xx),
//     the same body is re-dispatched to a handoff model instead.
const COMPACTION_ENABLED = !/^(0|false|off)$/i.test(process.env.PRISM_PROXY_COMPACTION || "1");
const COMPACTION_MODEL = process.env.PRISM_PROXY_COMPACTION_MODEL || "gpt-6.2-sol";
const COMPACTION_MIN_CHARS = Number(process.env.PRISM_PROXY_COMPACTION_MIN_BYTES) || 20000;
// Finish reasons that mean "the provider refused", not "the answer ended".
const BLOCKED_FINISH_RE = /^(content[-_]?filter|contentfilter|safety|blocked|refusal|sensitive)$/i;

function looksLikeCompaction(meta) {
  if (!COMPACTION_ENABLED || !meta.json) return false;
  if (meta.model === COMPACTION_MODEL) return false;
  const tools = meta.json.tools;
  if (Array.isArray(tools) && tools.length > 0) return false; // normal tool turn
  return meta.chars >= COMPACTION_MIN_CHARS;
}

function visionCacheGet(key) {
  const e = visionCache.get(key);
  if (!e) return null;
  if (Date.now() - e.time > VISION_CACHE_TTL_MS) { visionCache.delete(key); return null; }
  return e.text;
}

function visionCacheSet(key, text) {
  if (visionCache.size >= VISION_CACHE_MAX) {
    try { visionCache.delete(visionCache.keys().next().value); } catch {}
  }
  visionCache.set(key, { text, time: Date.now() });
}

function isImagePart(p) {
  if (!p || typeof p !== "object") return false;
  return p.type === "image_url" || p.type === "image" || p.type === "input_image";
}

function imageUrlOf(p) {
  if (p.type === "image_url") {
    if (typeof p.image_url === "string") return p.image_url;
    if (p.image_url && typeof p.image_url.url === "string") return p.image_url.url;
    return null;
  }
  if (p.type === "image") {
    if (p.source && typeof p.source.data === "string") {
      return `data:${p.source.media_type || "image/png"};base64,${p.source.data}`;
    }
    return p.url || null;
  }
  if (p.type === "input_image") return typeof p.image_url === "string" ? p.image_url : null;
  return null;
}

function collectImageParts(body) {
  const out = [];
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let mi = 0; mi < msgs.length; mi++) {
    const c = msgs[mi]?.content;
    if (!Array.isArray(c)) continue;
    for (let pi = 0; pi < c.length; pi++) {
      if (isImagePart(c[pi])) {
        const url = imageUrlOf(c[pi]);
        if (url) out.push({ mi, pi, url });
      }
    }
  }
  return out;
}

function targetMatches(model) {
  return VISION_TARGETS.some((t) =>
    t === "*" || t === model || (t.endsWith("*") && model.startsWith(t.slice(0, -1))));
}

// One non-streaming vision call against the same upstream and credentials.
async function analyzeImage({ auth, url, slot = 0 }) {
  const payload = {
    model: VISION_MODEL,
    stream: false,
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: VISION_PROMPT },
        { type: "image_url", image_url: { url } },
      ],
    }],
  };
  const headers = { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) };
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await acquire(VISION_MODEL, 0, 0, slot);
      const res = await postJson("/chat/completions", headers, payload);
      if (res.status >= 400) {
        lastErr = new Error(`vision status ${res.status}: ${res.text.slice(0, 200)}`);
      } else {
        const j = JSON.parse(res.text);
        const content = j?.choices?.[0]?.message?.content;
        if (typeof content === "string" && content.trim()) return content.trim();
        if (Array.isArray(content)) {
          const joined = content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("").trim();
          if (joined) return joined;
        }
        lastErr = new Error(`vision response had no content: ${res.text.slice(0, 160)}`);
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < 3) await sleep(400 * attempt);
  }
  throw lastErr || new Error("vision analysis failed");
}

// Replace every image part in `rawBody` with its caption. Returns the original
// buffer untouched when the model is not a configured target.
async function visionHandoff(rawBody, model, auth, force = false, slot = 0) {
  if (!VISION_ENABLED || !model || model === VISION_MODEL) return rawBody;
  if (!force && !targetMatches(model)) return rawBody;

  let json;
  try { json = JSON.parse(rawBody.toString("utf8")); } catch { return rawBody; }
  const imgs = collectImageParts(json);
  if (imgs.length === 0) {
    // Log what content types are in the messages, so a blind model that still
    // receives images in a format we don't recognize is visible.
    const types = new Set();
    for (const m of json.messages || []) {
      if (Array.isArray(m?.content)) for (const p of m.content) if (p?.type) types.add(p.type);
    }
    log(`vision handoff skipped model=${model}: no image_url parts found; content types: ${[...types].join(",") || "none"}`);
    return rawBody;
  }

  const origSize = rawBody.length;
  let analyzed = 0, cached = 0, failed = 0;
  for (const img of imgs) {
    const key = createHash("sha256").update(img.url).digest("hex");
    let desc = visionCacheGet(key);
    if (desc) {
      cached++;
    } else {
      try {
        desc = await analyzeImage({ auth, url: img.url, slot });
        visionCacheSet(key, desc);
        analyzed++;
      } catch (e) {
        log(`vision handoff failed: ${e?.message || e}`);
        desc = null;
        failed++;
      }
    }
    const msgs = json.messages;
    if (msgs?.[img.mi]?.content) {
      msgs[img.mi].content[img.pi] = {
        type: "text",
        text: desc
          ? `[Image attached by the user — description produced by ${VISION_MODEL}:]\n${desc}`
          : "[Image attached by the user — vision analysis unavailable]",
      };
    }
  }
  const out = Buffer.from(JSON.stringify(json), "utf8");
  log(`vision handoff model=${model} images=${imgs.length} analyzed=${analyzed} cached=${cached} failed=${failed} bytes ${origSize}->${out.length}`);
  return out;
}

// ---- upstream plumbing -----------------------------------------------------

const PROXY_STATE = { active: 0, queued: 0, started: Date.now(), requests: 0, retries: 0, retries5xx: 0 };

// Live retry state per OpenCode session, for the composer pill. Keyed by the
// x-opencode-session-id header OpenCode sends with every request.
const sessionRetries = new Map();

function noteSessionRetry(sessionId, status, model) {
  if (!sessionId) return;
  const e = sessionRetries.get(sessionId) || { retries: 0, status: status, model: model, since: Date.now(), updated: Date.now() };
  e.retries++;
  e.status = status;
  e.model = model;
  e.updated = Date.now();
  sessionRetries.set(sessionId, e);
}

function clearSessionRetry(sessionId) {
  if (sessionId) sessionRetries.delete(sessionId);
}

function sessionRetryReport(now) {
  const out = {};
  for (const [id, e] of sessionRetries) {
    if (now - e.updated > 5 * 60 * 1000) { sessionRetries.delete(id); continue; }
    out[id] = { retries: e.retries, status: e.status, model: e.model, ageMs: now - e.since };
  }
  return out;
}

function upstreamRequest(target, opts) {
  const mod = target.protocol === "https:" ? httpsRequest : httpRequest;
  return mod({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: opts.method,
    headers: opts.headers,
    agent: false,
    signal: opts.signal,
  });
}

function targetUrl(urlPath, model) {
  const base = ROOT_MODELS.has(model) ? ROOT_PATH : UPSTREAM_PATH;
  const suffix = urlPath.replace(/^\/v1(?=\/)/, "");
  return new URL(base + suffix, UPSTREAM);
}

async function appendRootModels(raw, headers, search) {
  try {
    const catalog = JSON.parse(raw);
    const url = new URL(`${ROOT_PATH}/models${search}`, UPSTREAM);
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await response.body?.cancel(); return raw; }
    const root = await response.json();
    const seen = new Set(catalog.data.map((entry) => entry.id));
    for (const entry of root.data) {
      if (ROOT_MODELS.has(entry.id) && !seen.has(entry.id)) {
        catalog.data.push(entry);
        seen.add(entry.id);
      }
    }
    return JSON.stringify(catalog);
  } catch { return raw; }
}

function postJson(urlPath, headers, payload, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = upstreamRequest(targetUrl(urlPath, payload.model), {
      method: "POST",
      headers: { ...headers, "content-length": String(body.length) },
    });
    const timer = setTimeout(() => { try { req.destroy(); } catch {} reject(new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    req.on("response", (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (c) => { if (size < 1 << 20) { chunks.push(c); size += c.length; } });
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode || 502, text: Buffer.concat(chunks).toString("utf8") }); });
      res.on("error", (e) => { clearTimeout(timer); reject(e); });
    });
    req.on("error", (e) => { clearTimeout(timer); reject(e); });
    req.end(body);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { chunks.push(c); size += c.length; });
    req.on("end", () => resolve(Buffer.concat(chunks, size)));
    req.on("error", reject);
  });
}

function buildForwardHeaders(inbound, bodyLength) {
  const out = {};
  for (const [k, v] of Object.entries(inbound)) {
    const key = k.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(key)) continue;
    if (key.startsWith("x-prism-")) continue; // local control headers
    out[k] = v;
  }
  out["content-length"] = String(bodyLength);
  out["accept-encoding"] = "identity"; // plain replies; decoderFor() covers the rest
  return out;
}

// Decoder for a compressed upstream reply, or null when the bytes are plain.
function decoderFor(encoding) {
  const e = String(encoding || "").trim().toLowerCase();
  if (e === "gzip" || e === "x-gzip") return zlib.createGunzip();
  if (e === "deflate") return zlib.createInflate();
  if (e === "br") return zlib.createBrotliDecompress();
  return null;
}

function parseRetryAfterMs(headers) {
  const raw = headers["retry-after"];
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n * 1000;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

async function waitForBadGateway(model, count, headers, signal, sessionId) {
  const backoff = Math.min(500 * 2 ** Math.min(count - 1, 5), 15000);
  const retryAfter = parseRetryAfterMs(headers);
  const wait = retryAfter > 0 ? Math.min(RETRY_AFTER_CAP_MS, Math.max(500, retryAfter)) : backoff;
  PROXY_STATE.retries5xx = (PROXY_STATE.retries5xx || 0) + 1;
  noteSessionRetry(sessionId, 502, model);
  log(`upstream 502 for ${model}; retrying in ${wait / 1000}s (gateway retry ${count})`);
  await waitForRetry(wait, signal);
}

// Learn the limit from the gateway's own error text, e.g.
//   "gpt-6.2-astra request limit reached (30 requests per minute). Try again in 29s."
const LIMIT_RE = /\((\d+)\s+requests?\s+per\s+(minute|hour)\)/i;
const RETRY_HINT_RE = /\b(?:try again|retry) in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|secs?|s)\b/i;
const KEY_LIMIT_RE = /\b(?:tokens?|requests?)\s+per\s+(?:minute|hour)\s+for\s+this\s+API\s+key\b/i;

function learnFrom429(model, headers, text, slot = 0) {
  let retryMs = parseRetryAfterMs(headers);
  let discovered = null;

  const m = LIMIT_RE.exec(text || "");
  if (m) {
    discovered = { max: Number(m[1]), windowMs: m[2].toLowerCase() === "hour" ? 3600000 : 60000 };
  }
  if (retryMs == null) {
    const h = RETRY_HINT_RE.exec(text || "");
    if (h) retryMs = Number(h[1]) * (/^m/i.test(h[2]) ? 1 : 1000);
  }
  if (retryMs == null) retryMs = 15000;
  retryMs = Math.max(0, Math.min(retryMs, RETRY_AFTER_CAP_MS));

  // Only the session's own key slot is blocked: a 429 on key 1 must not stall
  // a session pinned to key 2.
  let lim = limiterFor(model, slot);
  if (discovered) {
    if (!lim) {
      lim = new ModelLimiter(model, discovered.max, discovered.windowMs);
      limiters.set(slot ? `${slot}|${model}` : model, lim);
    } else if (lim.max !== discovered.max || lim.windowMs !== discovered.windowMs) {
      log(`learned ${model} limit from upstream: ${discovered.max}/${discovered.windowMs / 1000}s`);
      lim.max = discovered.max;
      lim.windowMs = discovered.windowMs;
    }
  }
  const keyWide = KEY_LIMIT_RE.test(text || "") || !discovered;
  if (keyWide) lim = globalLimiterFor(slot) || lim;
  if (lim) {
    lim.blockFor(retryMs, Date.now());
    lim.retries++;
  }
  return { limiter: lim, retryMs, keyWide };
}

function readRequest(body) {
  let json = null;
  try { json = JSON.parse(body.toString("utf8")); } catch {}
  return {
    json,
    model: typeof json?.model === "string" ? json.model : null,
    stream: json?.stream === true,
    maxTokens: json?.max_tokens ?? json?.max_completion_tokens ?? json?.max_output_tokens ?? null,
    // Inline images are base64: a single screenshot would otherwise make an
    // ordinary vision request look like a huge compaction prompt.
    chars: json ? JSON.stringify(json.messages || json.input || []).replace(/data:[^"\\]+/g, "data:image").length : 0,
  };
}

// ---- request handling ------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, `http://${LISTEN_HOST}`);

  // After a hot reload this copy only drains. Its connections must not stay open
  // for the client to reuse, or the next request would still reach the old code.
  activeResponses.add(res);
  res.on("close", () => activeResponses.delete(res));
  if (retired) { try { res.setHeader("connection", "close"); } catch {} }

  // CORS preflight for the panel's POST /ping.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    });
    return res.end();
  }

  // Replace the running code with the current index.js, no service restart. The
  // custom header makes this a non-simple request, so a web page cannot trigger
  // it: our CORS preflight does not allow the header.
  if (req.method === "POST" && url.pathname === "/admin/reload") {
    if (req.headers["x-prism-admin"] !== "1") {
      return sendJson(res, 403, JSON.stringify({ error: "send the x-prism-admin: 1 header" }));
    }
    res.on("finish", () => setTimeout(() => { hotReload().catch((e) => log(`hot reload failed: ${e?.stack || e}`)); }, 100));
    return send(res, 200, "application/json", JSON.stringify({ reloading: true }) + "\n", { "cache-control": "no-store" });
  }

  if (req.method === "GET" && url.pathname === "/healthz") {
    return send(res, 200, "text/plain", "prism-proxy OK\n");
  }
  if (req.method === "GET" && url.pathname === "/keys/reveal") {
    // The only route that returns a full key. It answers one key per request,
    // only to loopback, and refuses browser pages (http/https origins), so a web
    // page open in a browser cannot read a key from here.
    const origin = req.headers.origin || "";
    const ra = req.socket.remoteAddress || "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra) || /^https?:\/\//i.test(origin)) {
      return sendJson(res, 403, JSON.stringify({ error: "not available to this origin" }));
    }
    const slot = Number(url.searchParams.get("slot"));
    if (!Number.isInteger(slot) || slot < 1 || slot > keyPool.length) {
      return sendJson(res, 404, JSON.stringify({ error: "no such key" }));
    }
    return send(res, 200, "application/json", JSON.stringify({ slot, key: keyPool[slot - 1] }) + "\n",
      { "cache-control": "no-store", "access-control-allow-origin": origin || "null" });
  }

  if (url.pathname === "/keys") {
    if (req.method === "GET") {
      return send(res, 200, "application/json", JSON.stringify(keysReport(), null, 2) + "\n", CORS_HEADERS);
    }
    if (req.method === "POST") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8") || "{}"); } catch {}

      if (Array.isArray(body.keys)) {
        keyPool = [...new Set(body.keys.map((k) => String(k).trim()).filter(Boolean))].slice(0, MAX_KEYS);
      } else if (Number.isInteger(body.set) && typeof body.key === "string" && body.key.trim()) {
        // Address one slot directly, which is what the panel's Key 1 / Key 2
        // fields use.
        const n = body.set;
        if (n < 1 || n > MAX_KEYS) return sendJson(res, 400, JSON.stringify({ error: `slot must be 1..${MAX_KEYS}` }));
        const k = body.key.trim();
        while (keyPool.length < n) keyPool.push("");
        keyPool[n - 1] = k;
        keyPool = keyPool.filter(Boolean).slice(0, MAX_KEYS);
      } else if (body.pin && typeof body.pin.session === "string" && Number.isInteger(body.pin.key)) {
        const slot = body.pin.key;
        if (slot < 1 || slot > keyPool.length) {
          return sendJson(res, 400, JSON.stringify({ error: `no key ${slot}; ${keyPool.length} configured` }));
        }
        sessionKeyPins.set(body.pin.session, slot);
        const a = sessionActivity.get(body.pin.session);
        if (a) a.slots = []; // reset: the old slots were on a different key's limiter
        log(`pinned session ${body.pin.session} to key ${slot}`);
      } else if (typeof body.unpin === "string") {
        sessionKeyPins.delete(body.unpin);
        log(`unpinned session ${body.unpin}`);
      } else if (typeof body.add === "string" && body.add.trim()) {        const k = body.add.trim();
        if (keyPool.includes(k)) return sendJson(res, 409, JSON.stringify({ error: "key already configured" }));
        if (keyPool.length >= MAX_KEYS) return sendJson(res, 409, JSON.stringify({ error: `at most ${MAX_KEYS} keys` }));
        keyPool.push(k);
      } else if (Number.isInteger(body.remove) && body.remove >= 1) {
        if (body.remove <= keyPool.length) {
          keyPool.splice(body.remove - 1, 1);
          remapPinsAfterRemoval(body.remove);
        }
      } else {
        return sendJson(res, 400, JSON.stringify({ error: 'send {"keys":[...]}, {"add":"<key>"} or {"remove":<index>}' }));
      }

      saveKeys();
      log(`keys updated: ${keyPool.length} configured (${keyPool.map(maskKey).join(", ") || "none"})`);
      return send(res, 200, "application/json", JSON.stringify(keysReport(), null, 2) + "\n", CORS_HEADERS);
    }
  }

  if (req.method === "POST" && url.pathname === "/ping") {
    const raw = await readBody(req);
    let requested = null;
    try {
      const parsed = JSON.parse(raw.toString("utf8") || "{}");
      if (Array.isArray(parsed.models)) requested = parsed.models.filter((m) => typeof m === "string" && m);
    } catch {}

    const models = requested && requested.length
      ? [...new Set(requested)]
      : (process.env.PRISM_PROXY_PING_MODELS || PING_MODELS_DEFAULT.join(","))
        .split(",").map((s) => s.trim()).filter(Boolean);

    const auth = req.headers.authorization || lastAuthHeader;
    log(`ping ${models.length} model(s) via POST /ping: ${models.join(" ")}`);
    const results = await pingModels(models, auth);
    log(`ping done: ${results.map((r) => `${r.model}=${r.ok ? "ok" : r.skipped ? "skipped" : "fail"}`).join(" ")}`);
    return send(res, 200, "application/json", JSON.stringify({ updated: Date.now(), prompt: PING_PROMPT, results }, null, 2) + "\n",
      { "cache-control": "no-store", "access-control-allow-origin": "*" });
  }
  if (req.method === "GET" && url.pathname === "/usage") {
    return send(res, 200, "application/json", JSON.stringify(usageReport(), null, 2) + "\n",
      { "cache-control": "no-store", "access-control-allow-origin": "*" });
  }
  if (req.method === "GET" && url.pathname === "/status") {
    const now = Date.now();
    // Each key slot has its own windows. The account total is the per-key cap
    // times the number of keys: usage is summed across slots, the cap is not.
    const accountKeys = Math.max(1, keyPool.length);
    const global = {};
    for (const [name, lim] of globalLimiters) global[name] = lim.snapshot(now);
    const models = {};
    for (const lim of limiters.values()) {
      const snap = lim.snapshot(now);
      const cur = models[lim.model];
      if (!cur) { models[lim.model] = { ...snap }; continue; }
      cur.used += snap.used;
      cur.tokensUsed += snap.tokensUsed;
      cur.total += snap.total;
      cur.throttled += snap.throttled;
      cur.retries += snap.retries;
      cur.shed += snap.shed;
      cur.blockedMs = Math.max(cur.blockedMs, snap.blockedMs);
    }
    for (const [name, m] of Object.entries(models)) {
      const cfg = LIMITS.get(name) || LIMIT_FALLBACK;
      const tok = TOKEN_LIMITS.get(name) || TOKEN_FALLBACK;
      m.max = cfg ? cfg.max * accountKeys : 0;
      m.tokenMax = tok ? tok.max * accountKeys : 0;
    }
    return send(res, 200, "application/json", JSON.stringify({
      proxy: "prism-proxy",
      instance: INSTANCE_ID,
      upstream: UPSTREAM.href,
      uptimeMs: now - PROXY_STATE.started,
      active: PROXY_STATE.active,
      queued: PROXY_STATE.queued,
      requests: PROXY_STATE.requests,
      retries429: PROXY_STATE.retries,
      vision: {
        enabled: VISION_ENABLED,
        model: VISION_MODEL,
        targets: VISION_TARGETS,
        cachedCaptions: visionCache.size,
      },
      overflow: {
        rules: Object.fromEntries([...OVERFLOW].map(([k, v]) => [k, `${v.to}:${v.maxWaitMs / 1000}s`])),
        spills: Object.fromEntries(overflowStats),
        // target -> spills in the last minute (count), how many are still running
        // (inFlight) and which models they came from
        active: overflowReport(now),
      },
      sessions: sessionRetryReport(now),
      retries5xx: PROXY_STATE.retries5xx || 0,
      compaction: {
        enabled: COMPACTION_ENABLED,
        handoffModel: COMPACTION_MODEL,
        minPromptChars: COMPACTION_MIN_CHARS,
        handoffs: PROXY_STATE.compactionHandoffs || 0,
      },
      keys: accountKeys,
      // Account totals: the per-key caps times the configured key count.
      globalLimits: {
        requests: GLOBAL_LIMIT ? `${GLOBAL_LIMIT.max * accountKeys}/${GLOBAL_LIMIT.windowMs / 1000}s` : "off",
        tokens: GLOBAL_TOKEN_LIMIT ? `${GLOBAL_TOKEN_LIMIT.max * accountKeys}/${GLOBAL_TOKEN_LIMIT.windowMs / 1000}s` : "off",
      },
      global,
      limits: Object.fromEntries(
        [...LIMITS].filter(([k]) => k !== "*").map(([k, v]) => [k, `${v.max * accountKeys}/${v.windowMs / 1000}s`])),
      tokenLimits: Object.fromEntries(
        [...TOKEN_LIMITS].filter(([k]) => k !== "*").map(([k, v]) => [k, `${v.max * accountKeys}/${v.windowMs / 1000}s`])),
      models,
      updated: now,
    }, null, 2) + "\n", { "cache-control": "no-store", "access-control-allow-origin": "*" });
  }

  let body = await readBody(req);
  if (res.destroyed) return;
  const abort = new AbortController();
  const { signal } = abort;
  res.once("close", () => { if (!res.writableEnded) abort.abort(); });
  let meta = readRequest(body);
  let model = meta.model;
  const isChat = url.pathname.includes("/chat/completions");
  const isResponses = req.method === "POST" && /^\/(?:v1\/)?responses\/?$/.test(url.pathname);
  const isMessages = req.method === "POST" && /^\/(?:v1\/)?messages\/?$/.test(url.pathname);
  const isImage = req.method === "POST" && /^\/(?:v1\/)?images\/(generations|edits)\/?$/.test(url.pathname);
  const contentType = req.headers["content-type"] || "";
  if (isImage && /^multipart\/form-data\b/i.test(contentType)) {
    try {
      const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
      const field = form.get("model");
      model = typeof field === "string" ? field : null;
    } catch { return sendJson(res, 400, '{"error":{"message":"Invalid multipart image request"}}'); }
  }
  const sessionId = req.headers["x-opencode-session-id"] || req.headers["x-opencode-session"] || null;
  // With a key pool configured, this request goes out on the key its session is
  // pinned to, and follows that key's windows rather than the shared ones.
  const keySlot = keySlotForSession(sessionId);
  if (keySlot >= 1 && keySlot <= keyPool.length) {
    req.headers.authorization = `Bearer ${keyPool[keySlot - 1]}`;
    if (req.headers["x-api-key"]) req.headers["x-api-key"] = keyPool[keySlot - 1];
  }
  const started = Date.now();

  log(`req ${req.method} ${url.pathname} model=${model || "-"} stream=${meta.stream} bytes=${body.length} max_tokens=${meta.maxTokens ?? "default"} key=${keySlot || "-"}`);

  PROXY_STATE.requests++;
  PROXY_STATE.active++;
  let spill = null; // { target, from } while this request is served by a fallback
  // Mark the session live, with a request in flight, for the panel's session list.
  const sessionAct = sessionId ? touchSession(sessionId, model) : null;
  if (sessionAct) sessionAct.active++;
  try {
    if (req.headers.authorization) lastAuthHeader = req.headers.authorization;
    if (isChat) body = trimOldImages(body);
    // Normal chat requests too: a body bigger than the model's context is refused
    // upstream ("Provider returned error", 502). Keep the first message and the
    // newest turns, as compaction does.
    if (isChat && model && CONTEXT_WINDOWS[model] && estimateTokens(body) > CONTEXT_WINDOWS[model] * 0.9) {
      const trimmed = trimConversationForCompaction(body, Math.floor(CONTEXT_WINDOWS[model] * 0.8));
      if (trimmed) {
        log(`chat body trimmed for ${model}: ${body.length} -> ${trimmed.length} bytes (over the context window)`);
        body = trimmed;
      }
    }
    if (isChat && model) {
      body = await visionHandoff(body, model, req.headers.authorization, false, keySlot);
      const after = readRequest(body);
      if (after.model) meta = after;
      model = after.model || model;
    }

    // Compaction: no tools + a large prompt. Wait for other requests to settle
    // so it does not compete for the per-minute window, then run it with a
    // fallback model if the provider blocks the summary.
    if (isChat && model && looksLikeCompaction(meta)) {
      await deferWhileBusy(model, signal);
      return await runCompaction(req, res, url, body, model, keySlot, signal);
    }

    let estTokens = estimateTokens(body, meta.maxTokens);
    let reservation = null;
    let spilledFrom = null;

    // Send this request to the overflow model instead of waiting on `model`.
    const spillOver = (why) => {
      const rule = OVERFLOW.get(model);
      if (!rule || spilledFrom) return false;
      spilledFrom = model;
      const stat = overflowStats.get(model) || { to: rule.to, count: 0 };
      stat.to = rule.to;
      stat.count++;
      overflowStats.set(model, stat);
      log(`overflow ${model} -> ${rule.to} (${why})`);
      body = rewriteModel(body, rule.to);
      estTokens = estimateTokens(body, meta.maxTokens);
      const from = model;
      model = rule.to;
      spill = { target: rule.to, from };
      markOverflowActive(rule.to, from);
      if (sessionAct) { sessionAct.model = rule.to; sessionAct.spilledFrom = from; }
      reservation = null;
      return true;
    };

    // A request that carries images may be refused upstream; if so it is retried
    // once with the images captioned. Only possible when a vision model exists.
    const reqJson = isChat && VISION_ENABLED ? readRequest(body).json : null;
    let imageFallback = !!reqJson && model !== VISION_MODEL && collectImageParts(reqJson).length > 0;

    const textRequest = isChat || isResponses || isMessages;
    let gatewayAttempts = 0;
    let serverAttempts = 0;
    let rateAttempts = 0;
    const budgetStart = Date.now();
    const reserveAttempt = async (maxWaitMs) => {
      PROXY_STATE.queued++;
      try { return await acquire(model, estTokens, maxWaitMs, keySlot, signal); } finally { PROXY_STATE.queued--; }
    };
    while (!signal.aborted && !res.writableEnded) {
      if ((textRequest || isImage) && model && hasLimiter(model, keySlot)) {
        const rule = !gatewayAttempts && !spilledFrom && OVERFLOW.get(model);
        reservation = await reserveAttempt(rule ? rule.maxWaitMs : 0);
        if (reservation?.spill) {
          spillOver(`a slot would take over ${rule.maxWaitMs / 1000}s`);
          reservation = await reserveAttempt(0);
        }
        noteSessionSlot(sessionAct, model, reservation);
      }
      if (signal.aborted || res.writableEnded) return;
      const result = await forward(req, res, url, body, model, isChat, {
        headers: spilledFrom ? { "x-prism-overflow": `${spilledFrom}->${model}` } : {},
        imageFallback,
        retry5xx: textRequest,
        signal,
        isMessages, isImage,
        retry429: !!model && (textRequest || isImage),
      });
      if (signal.aborted) return;
      if (result.gatewayError) {
        await waitForBadGateway(model, ++gatewayAttempts, result.headers, signal, sessionId);
        continue;
      }
      gatewayAttempts = 0;
      if (result.done) {
        const tokens = recordUsage(model, result, Date.now() - started, keySlot, isImage);
        const measured = tokens ?? estTokens + Math.ceil((isImage ? 0 : result.bytes || 0) / 4);
        // The gateway can meter the admission estimate even when the reply uses fewer tokens.
        reconcileTokens(reservation, Math.max(estTokens, measured), 0);
        return;
      }
      if (result.visionFallback) {
        imageFallback = false;
        log(`upstream rejected an image request for ${model} (400); retrying with captions :: ${String(result.text).replace(/\s+/g, " ").slice(0, 160)}`);
        body = await visionHandoff(body, model, req.headers.authorization, true, keySlot);
        estTokens = estimateTokens(body, meta.maxTokens);
        continue;
      }
      if (result.serverError) {
        // 5xx from the gateway or its CDN. Usually transient; retry the same
        // body with backoff, and record it per session for the UI. A stream
        // error (upstream_rejected_request) is NOT transient: the provider
        // refused the body, and the same body will be refused again, so it is
        // forwarded after the first attempt.
        const attemptNo = (serverAttempts += 1);
        PROXY_STATE.retries5xx = (PROXY_STATE.retries5xx || 0) + 1;
        noteSessionRetry(sessionId, result.status, model);
        const refused = result.text?.includes("upstream_rejected_request") || result.text?.includes("Provider returned error");
        if (attemptNo > MAX_5XX_RETRIES || refused || Date.now() - budgetStart > RATE_LIMIT_BUDGET_MS) {
          log(`upstream ${result.status} for ${model} after ${attemptNo - 1} retries${refused ? " (provider refused the body)" : ""}; forwarding it (${body.length} bytes)`);
          clearSessionRetry(sessionId);
          return sendJson(res, result.status, result.text);
        }
        const wait = Math.min(500 * 2 ** (attemptNo - 1), 15000);
        log(`upstream ${result.status} for ${model} (${body.length} bytes); retrying in ${wait / 1000}s (attempt ${attemptNo}/${MAX_5XX_RETRIES})`);
        await waitForRetry(wait, signal);
        continue;
      }
      const { retryMs, keyWide } = learnFrom429(model, result.headers, result.text, keySlot);
      reconcileTokens(reservation, 0, 0);
      if (++rateAttempts > MAX_429_RETRIES || Date.now() - budgetStart + retryMs > RATE_LIMIT_BUDGET_MS) {
        log(`429 budget exhausted for ${model}, forwarding the 429`);
        const retryAfter = result.headers["retry-after"] || String(Math.ceil(retryMs / 1000));
        return sendJson(res, result.status, result.text, { "retry-after": retryAfter });
      }
      PROXY_STATE.retries++;
      noteSessionRetry(sessionId, result.status, model);
      const rule = OVERFLOW.get(model);
      if (!keyWide && rule && !spilledFrom && retryMs > rule.maxWaitMs) {
        spillOver(`upstream 429, retry in ${Math.round(retryMs / 1000)}s`);
        continue;
      }
      log(`upstream 429 for ${model}; waiting ${Math.round(retryMs / 1000)}s (retry ${rateAttempts}/${MAX_429_RETRIES})`);
      await waitForRetry(retryMs, signal);
    }
  } finally {
    if (spill) clearOverflowActive(spill.target, spill.from);
    if (sessionAct) sessionAct.active = Math.max(0, sessionAct.active - 1);
    clearSessionRetry(sessionId);
    PROXY_STATE.active--;
    log(`done ${url.pathname} model=${model || "-"} in ${Date.now() - started}ms`);
  }
}

// One upstream attempt. Resolves {done:true} when the client has been answered,
// or {retry:true,status,headers,text} when the 429 should be absorbed.
function forward(req, res, url, body, model, isChat, opts = {}) {
  return new Promise((resolve) => {
    const headers = buildForwardHeaders(req.headers, body.length);

    let settled = false;
    let respBytes = 0;
    let firstByteAt = 0;
    // Timing for tok/s. The clock starts at the first frame that carries model
    // text, not the first byte: SSE keep-alives and role-only frames are not
    // generation, and counting them makes slow starts look like slow decoding.
    let firstTokenAt = 0;
    let lastTokenAt = 0;
    let tokenFrames = 0;
    let sawReasoning = false;
    const sentAt = Date.now();
    let tail = "";
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    let up;
    try {
      up = upstreamRequest(targetUrl(url.pathname + url.search, model), { method: req.method, headers, signal: opts.signal });
    } catch (err) {
      log(`upstream request failed: ${err?.message || err}`);
      send(res, 502, "text/plain", `prism-proxy: ${err?.message || err}\n`);
      return finish({ done: true });
    }

    up.on("error", (err) => {
      if (settled) return;
      if (opts.signal?.aborted) return finish({ done: true });
      if (res.headersSent) { try { res.end(); } catch {} return finish({ done: true }); }
      log(`upstream error: ${err?.message || err}`);
      send(res, 502, "text/plain", `prism-proxy upstream error: ${err?.message || err}\n`);
      finish({ done: true });
    });

    up.on("response", (rawRes) => {
      const status = rawRes.statusCode || 502;
      if (status === 502 && opts.retry5xx) {
        finish({ gatewayError: true, headers: rawRes.headers });
        rawRes.destroy();
        return;
      }
      // We ask for identity, but the gateway may still compress a reply. Decode it
      // here: the client gets plain bytes and the headers stay consistent with them.
      // Passing compressed bytes with a content-encoding header, or decoding them as
      // text, is what makes the client fail with "error decoding response body".
      const dec = decoderFor(rawRes.headers["content-encoding"]);
      const upRes = dec ? rawRes.pipe(dec) : rawRes;
      if (dec) rawRes.on("error", (e) => dec.destroy(e));
      const eventStream = String(rawRes.headers["content-type"] || "").includes("event-stream");
      const sse = isChat && status === 200 && eventStream;
      let held = null;
      let holdDone = false;
      const readUsage = status === 200 && (opts.isMessages || opts.isImage)
        ? captureNativeUsage(upRes, eventStream, opts.isMessages) : null;
      upRes.on("data", (c) => {
        respBytes += c.length;
        if (!firstByteAt) firstByteAt = Date.now();
        const text = c.toString("utf8");
        if (status === 200) {
          tail = (tail + text).slice(-8192);
          // A frame counts as generation when it carries content or reasoning.
          if (/"(content|reasoning|reasoning_content|text)"\s*:\s*"[^"]/.test(text)) {
            const now = Date.now();
            if (!firstTokenAt) firstTokenAt = now;
            lastTokenAt = now;
            tokenFrames++;
            if (/"(reasoning|reasoning_content)"\s*:\s*"[^"]/.test(text)) sawReasoning = true;
          }
        }
        // First chunk of a 200 SSE stream: check for an error frame before the
        // client sees anything. Both error frames and real chunks can share the
        // chunk, so an error only blocks when no real content is beside it.
        if (sse && !holdDone && held === null) {
          held = c;
          const looksError = /"error"\s*:\s*(?!null\b)[{"]/.test(text) && !/"choices"/.test(text) && !/"(content|reasoning|reasoning_content|text)"\s*:\s*"/.test(text);
          if (looksError) {
            holdDone = true; // nothing goes to the client from this stream
            const errText = text.replace(/\s+/g, " ").slice(0, 400);
            log(`res 200 (stream error) model=${model || "-"} :: ${errText}`);
            if (!res.headersSent) {
              if (isChat && opts.retry5xx) return finish({ serverError: true, status: 502, headers: rawRes.headers, text: errText });
              res.writeHead(502, { "content-type": "text/plain" });
              res.end(`prism-proxy: upstream stream error: ${errText}\n`);
              return finish({ done: true });
            }
            try { res.end(); } catch {}
            return finish({ done: true });
          }
          releaseHeld();
          return;
        }
        if (sse && !holdDone) return; // still holding; more data waits for the first-chunk decision
      });
      const hdrs = { ...rawRes.headers, ...(opts.headers || {}) };
      delete hdrs["transfer-encoding"];
      delete hdrs["content-length"];
      delete hdrs.connection;
      if (dec) delete hdrs["content-encoding"]; // the bytes below are already decoded

      if (status === 200 && req.method === "GET" && /^\/(?:v1\/)?models\/?$/.test(url.pathname) && ROOT_PATH !== UPSTREAM_PATH) {
        const auth = {};
        for (const name of ["authorization", "x-api-key"]) if (headers[name]) auth[name] = headers[name];
        delete hdrs.etag;
        readBody(upRes).then((raw) => appendRootModels(raw, auth, url.search)).then((catalog) => {
          res.writeHead(status, hdrs);
          res.end(catalog);
          finish({ done: true });
        }).catch(() => { sendJson(res, 502, '{"error":{"message":"Failed to read upstream model catalog"}}'); finish({ done: true }); });
        return;
      }

      // A 200 SSE stream can still carry an error frame as its first data line
      // (e.g. `data: {"error":{"code":"upstream_rejected_request",...}}`): the
      // provider failed after the HTTP status was already 200. Buffer the first
      // chunk and check before anything reaches the client, so the turn can be
      // retried instead of failing with "Provider returned error".
      const releaseHeld = () => {
        if (holdDone || held === null) return;
        holdDone = true;
        res.writeHead(status, hdrs);
        res.write(held);
        held = null;
        upRes.pipe(res); // only the remaining chunks are piped
      };

      if (status !== 200) {
        // Always leave a trace of a non-2xx: this is what makes a failed turn
        // attributable instead of an opaque "blocked by the provider".
        const ct = String(hdrs["content-type"] || "");
        const retryable = opts.retry5xx && (isChat ? status >= 500 : [503, 504, 520, 522, 524].includes(status));
        const throttled = status === 429 && opts.retry429;
        if (throttled || retryable || !ct.includes("event-stream")) {
          const chunks = [];
          let size = 0;
          upRes.on("data", (c) => { if (size < 65536) { chunks.push(c); size += c.length; } });
          upRes.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            log(`res ${status} model=${model || "-"} :: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
            if (throttled) return finish({ retry: true, status, headers: rawRes.headers, text });
            // Transient 5xx: let the caller retry the same body.
            if (retryable) {
              return finish({ serverError: true, status, headers: rawRes.headers, text });
            }
            // The upstream refused a request that carries images: let the caller
            // retry once with the images captioned instead of failing the turn.
            if (status === 400 && opts.imageFallback) return finish({ visionFallback: true, status, text });
            res.writeHead(status, hdrs);
            res.end(text);
            finish({ done: true });
          });
          upRes.on("error", () => {
            if (retryable) return finish({ serverError: true, status, headers: rawRes.headers, text: "" });
            if (throttled) return finish({ retry: true, status, headers: upRes.headers, text: "" });
            try { res.end(); } catch {}
            finish({ done: true });
          });
          return;
        }
      }

      log(`res ${status} model=${model || "-"} ct=${hdrs["content-type"] || "-"}`);
      if (sse) {
        // SSE: release held first chunk at end if the error check never ran
        upRes.on("end", () => { releaseHeld(); finish({ done: true, status, bytes: respBytes, tail, timing: timing2() }); });
        upRes.on("error", () => { try { res.end(); } catch {} finish({ done: true, status, bytes: respBytes, tail, timing: timing2() }); });
      } else {
        res.writeHead(status, hdrs);
        upRes.pipe(res);
        upRes.on("end", () => finish({ done: true, status, bytes: respBytes, tail, usage: readUsage?.(), timing: timing2() }));
        upRes.on("error", () => { try { res.end(); } catch {} finish({ done: true, status, bytes: respBytes, tail, usage: readUsage?.(), timing: timing2() }); });
      }
    });

    function timing2() { return { sentAt, firstTokenAt, lastTokenAt, tokenFrames, sawReasoning }; }

    up.end(body);
  });
}

// ---- compaction path -------------------------------------------------------

function reconcileTokens(reservation, estTokens, respBytes) {
  if (!reservation) return;
  const actual = estTokens + Math.ceil((respBytes || 0) / 4);
  if (reservation.global) reservation.global.limiter.reconcile(reservation.global.entry, actual);
  if (reservation.model) reservation.model.limiter.reconcile(reservation.model.entry, actual);
  if (!reservation.global && !reservation.model) reservation.limiter.reconcile(reservation.entry, actual);
}

// Rough prompt size, with inline data URLs collapsed so a screenshot is not
// counted as hundreds of thousands of text tokens before it reaches upstream.
function estimateTokens(body, maxOutput) {
  let text = body.toString("utf8");
  if (text.includes("data:")) text = text.replace(/data:[^"\\]+/g, "data:image");
  const outputBudget = Number.isSafeInteger(maxOutput) && maxOutput > 0 ? maxOutput : 0;
  return Math.ceil(text.length / 4) + outputBudget;
}

// Wait until no other request is in flight. The compaction request is the one
// whose failure costs a whole turn, so it gets a quiet window instead of racing
// long turns for the same per-minute budget.
async function deferWhileBusy(model, signal) {
  const t0 = Date.now();
  while (PROXY_STATE.active > 1 && !signal.aborted) {
    await waitForRetry(250, signal);
    if (Date.now() - t0 > 120000) break; // never park a turn forever
  }
  const waited = Date.now() - t0;
  if (waited > 500) log(`deferred compaction ${model} ${(waited / 1000).toFixed(1)}s until in-flight requests settled`);
}

// Two limits, so long screenshot sessions stay small in bytes AND in image count:
// 1. The gateway refuses bodies over 12 MB (413 request_too_large). OpenCode reads
//    that as "too long" and compacts even when the token count is far under the
//    window. Over the byte trigger, the oldest images are replaced with a short
//    note until the body is under the target.
// 2. A cap on the number of images kept (like UMANS' limitImagesInMessages):
//    22 screenshots of one session is 22 vision reads even when each is small.
//    The newest MAX_IMAGES are kept; the rest become "(Image previously shared)".
const IMAGE_SHRINK_TRIGGER = Math.round((Number(process.env.PRISM_PROXY_IMAGE_SHRINK_MB) || 8) * 1024 * 1024);
const IMAGE_SHRINK_TARGET = Math.round(IMAGE_SHRINK_TRIGGER * 0.9);
const IMAGE_SHRINK_NOTE = "[image removed to keep the request under the 12 MB gateway limit]";
const IMAGE_COUNT_NOTE = "(Image previously shared)";
const MAX_IMAGES = Math.max(0, Number(process.env.PRISM_PROXY_MAX_IMAGES) || 6);

function trimOldImages(body) {
  let json;
  try { json = JSON.parse(body.toString("utf8")); } catch { return body; }
  const imgs = collectImageParts(json); // oldest first
  let dropped = 0;
  let size = body.length;

  // 1. Byte-size cap: drop the oldest until under the byte target.
  if (size > IMAGE_SHRINK_TRIGGER) {
    for (const im of imgs) {
      if (size <= IMAGE_SHRINK_TARGET) break;
      const content = json.messages[im.mi].content;
      const before = Buffer.byteLength(JSON.stringify(content[im.pi]), "utf8");
      content[im.pi] = { type: "text", text: IMAGE_SHRINK_NOTE };
      size -= before - Buffer.byteLength(JSON.stringify(content[im.pi]), "utf8");
      dropped++;
    }
  }

  // 2. Count cap: keep only the newest MAX_IMAGES image parts. Older ones
  //    that survived the byte cap (because they are small) become a note.
  const survivors = [];
  for (const im of imgs) {
    const content = json.messages[im.mi]?.content;
    if (content && isImagePart(content[im.pi])) survivors.push(im);
  }
  const toDrop = survivors.length - MAX_IMAGES;
  for (let i = 0; i < toDrop; i++) {
    const im = survivors[i];
    const content = json.messages[im.mi].content;
    content[im.pi] = { type: "text", text: IMAGE_COUNT_NOTE };
    dropped++;
  }

  if (!dropped) return body;
  const out = Buffer.from(JSON.stringify(json), "utf8");
  const keptCount = Math.max(0, survivors.length - Math.max(0, toDrop));
  log(`dropped ${dropped} old image(s) (byte cap and/or ${MAX_IMAGES}-image cap): ${body.length} -> ${out.length} bytes, images kept: ${keptCount}`);
  return out;
}

// Context windows from models.dev. Used only to decide when a request is too
// big to send whole; unlisted models are not trimmed.
const CONTEXT_WINDOWS = {
  "gpt-4.1": 1047576,
  "gpt-4o": 128000,
  "gpt-5": 400000,
  "gpt-5.1": 400000,
  "gpt-5.2": 400000,
  "gpt-5.4": 1050000,
  "gpt-5.4-pro": 1050000,
  "gpt-5.5": 1050000,
  "gpt-5.6-luna": 1050000,
  "gpt-5.6-terra": 1050000,
  "gpt-5.6-sol": 1050000,
  "gpt-6-sol": 1050000,
  "gpt-6-luna": 1050000,
  "gpt-6.1-sol": 1050000,
  "gpt-6.1-terra": 1050000,
  "gpt-6.2-sol": 1050000,
  "gpt-6.2-astra": 1050000,
  "gpt-5-codex": 400000,
  "gpt-5.1-codex": 400000,
  "gpt-5.2-codex": 400000,
  "gpt-5.3-codex": 400000,
};

// Trim a compaction body so the summary request fits in the model's context.
// Keeps the system prompt (if any) and the most recent messages; drops older
// middle messages, replacing them with a note.
function trimConversationForCompaction(body, maxTokens) {
  let json;
  try { json = JSON.parse(body.toString("utf8")); } catch { return null; }
  const msgs = json.messages;
  if (!Array.isArray(msgs) || msgs.length < 3) return null;

  // Estimate tokens per message (rough: bytes / 4)
  const msgTokens = msgs.map((m) => {
    const s = JSON.stringify(m);
    return Math.ceil(s.replace(/data:[^"\\]+/g, "data:image").length / 4);
  });
  const total = msgTokens.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) return null;

  // Keep the first message (often system or first user) and the last N messages.
  // Drop from the front of the conversation (oldest first).
  const keep = 1; // first
  let budget = maxTokens - msgTokens.slice(-keep).reduce((a, b) => a + b, 0) - msgTokens[0];
  if (budget < 100) budget = 100;

  // Walk from the end, keeping messages until budget is spent.
  let keptFromEnd = 0;
  for (let i = msgs.length - 1; i > keep; i--) {
    if (budget - msgTokens[i] < 0) break;
    budget -= msgTokens[i];
    keptFromEnd++;
  }

  const firstMsg = msgs[0];
  const keptMsgs = msgs.slice(msgs.length - keptFromEnd);
  const dropped = msgs.length - 1 - keptFromEnd;
  json.messages = [
    firstMsg,
    { role: "system", content: `[${dropped} earlier messages omitted to fit the context window for this summary request]` },
    ...keptMsgs,
  ];
  return Buffer.from(JSON.stringify(json), "utf8");
}

function rewriteModel(body, model) {
  try {
    const json = JSON.parse(body.toString("utf8"));
    json.model = model;
    return Buffer.from(JSON.stringify(json), "utf8");
  } catch {
    return body;
  }
}

// One upstream attempt, fully buffered. Used only for compaction: the response
// is small enough to hold, and we must see the finish reason before deciding to
// forward it or hand off to the fallback model.
function forwardBuffered(req, url, body, model, signal) {
  return new Promise((resolve) => {
    const headers = buildForwardHeaders(req.headers, body.length);
    let up;
    try {
      up = upstreamRequest(targetUrl(url.pathname + url.search, model), { method: req.method, headers, signal });
    } catch (err) {
      return resolve({ status: 502, headers: {}, text: `prism-proxy: ${err?.message || err}`, finish: null });
    }
    up.on("error", (err) => resolve({ status: 502, headers: {}, text: `prism-proxy upstream error: ${err?.message || err}`, finish: null }));
    up.on("response", (upRes) => {
      if (upRes.statusCode === 502) {
        resolve({ gatewayError: true, headers: upRes.headers });
        upRes.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      upRes.on("data", (c) => { chunks.push(c); size += c.length; });
      upRes.on("end", () => {
        const text = Buffer.concat(chunks, size).toString("utf8");
        const hdrs = { ...upRes.headers };
        resolve({
          status: upRes.statusCode || 502,
          headers: hdrs,
          text,
          finish: extractFinish(upRes.headers["content-type"], text),
        });
      });
      upRes.on("error", (err) => resolve({ status: 502, headers: {}, text: `prism-proxy stream error: ${err?.message || err}`, finish: null }));
    });
    up.end(body);
  });
}

function extractFinish(contentType, text) {
  if (String(contentType || "").includes("event-stream")) {
    let last = null;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const m = /"finish_reason"\s*:\s*"([^"]+)"/.exec(t);
      if (m) last = m[1];
    }
    return last;
  }
  try {
    const j = JSON.parse(text);
    const r = j?.choices?.[0]?.finish_reason;
    if (typeof r === "string") return r;
    if (j?.error) return "error";
  } catch {}
  return null;
}

function isBlockedCompaction(r) {
  if (r.finish && BLOCKED_FINISH_RE.test(r.finish)) return true;
  if (r.finish === "error") return true;
  if (r.status >= 400) return true; // 429 is handled before this point
  return false;
}

function writeBuffered(res, r) {
  const hdrs = { ...r.headers };
  delete hdrs["transfer-encoding"];
  delete hdrs["content-length"];
  delete hdrs.connection;
  try {
    res.writeHead(r.status, hdrs);
    res.end(r.text);
  } catch {}
}

// Runs compaction on the original model, then the handoff model if refused.
async function runCompaction(req, res, url, body, model, slot, signal) {
  let estTokens = estimateTokens(body);
  // A compaction request can be larger than the model's context: the whole
  // conversation is sent to summarize. Trim it to the most recent messages
  // so the summary request fits, keeping the system prompt and the latest turn.
  const ctxLimit = CONTEXT_WINDOWS[model] || 1_000_000;
  if (estTokens > ctxLimit * 0.85) {
    const trimmed = trimConversationForCompaction(body, Math.floor(ctxLimit * 0.7));
    if (trimmed && trimmed.length < body.length) {
      log(`compaction body trimmed for ${model}: ${body.length} -> ${trimmed.length} bytes (est ${estTokens} -> ${estimateTokens(trimmed)} tokens)`);
      body = trimmed;
      estTokens = estimateTokens(body);
    }
  }
  const sessionId = req.headers["x-opencode-session-id"] || req.headers["x-opencode-session"];
  const dispatch = async (target, payload) => {
    const tokens = estimateTokens(payload, readRequest(payload).maxTokens);
    let gatewayAttempts = 0;
    while (!signal.aborted) {
      let reservation = null;
      if (hasLimiter(target, slot)) {
        PROXY_STATE.queued++;
        try { reservation = await acquire(target, tokens, 0, slot, signal); } finally { PROXY_STATE.queued--; }
      }
      if (signal.aborted) return null;
      const r = await forwardBuffered(req, url, payload, target, signal);
      if (signal.aborted) return null;
      if (r.gatewayError) {
        await waitForBadGateway(target, ++gatewayAttempts, r.headers, signal, sessionId);
        continue;
      }
      reconcileTokens(reservation, r.status === 429 ? 0 : Math.max(tokens, usageTokens(r.text) || 0), 0);
      return r;
    }
    return null;
  };

  const budgetStart = Date.now();
  for (let attempt = 1; attempt <= MAX_429_RETRIES + 1; attempt++) {
    const r = await dispatch(model, body);
    if (!r) return;

    if (r.status === 429) {
      const { retryMs } = learnFrom429(model, r.headers, r.text, slot);
      if (attempt > MAX_429_RETRIES || Date.now() - budgetStart + retryMs > RATE_LIMIT_BUDGET_MS) {
        r.headers["retry-after"] ??= String(Math.ceil(retryMs / 1000));
        writeBuffered(res, r);
        return;
      }
      PROXY_STATE.retries++;
      noteSessionRetry(sessionId, r.status, model);
      log(`upstream 429 for ${model} (compaction, key ${slot || "-"}); waiting ${Math.round(retryMs / 1000)}s (attempt ${attempt})`);
      await waitForRetry(retryMs, signal);
      continue;
    }

    if (!isBlockedCompaction(r)) {
      log(`compaction ok model=${model} status=${r.status} finish=${r.finish || "-"} bytes=${r.text.length}`);
      writeBuffered(res, r);
      return;
    }

    log(`compaction blocked model=${model} status=${r.status} finish=${r.finish || "-"}; handing off to ${COMPACTION_MODEL}`);
    PROXY_STATE.compactionHandoffs = (PROXY_STATE.compactionHandoffs || 0) + 1;
    const r2 = await dispatch(COMPACTION_MODEL, rewriteModel(body, COMPACTION_MODEL));
    if (!r2) return;
    log(`compaction handoff model=${COMPACTION_MODEL} status=${r2.status} finish=${r2.finish || "-"} bytes=${r2.text.length}`);
    writeBuffered(res, r2);
    return;
  }
}

function usageTokens(text) {
  const re = /"total_tokens"\s*:\s*(\d+)/g;
  let last = null, m;
  while ((m = re.exec(text))) last = Number(m[1]);
  return last;
}

function send(res, status, type, text, extra = {}) {  try {
    res.writeHead(status, { "content-type": type, ...extra });
    res.end(text);
  } catch {}
}

function sendJson(res, status, text, headers) {
  let type = "application/json";
  try { JSON.parse(text); } catch { type = "text/plain"; }
  send(res, status, type, text || `{"error":{"message":"upstream ${status}"}}`, headers);
}

// ---- server ----------------------------------------------------------------

async function startServer(port, mode) {
  const server = createServer();
  server.on("request", (req, res) => {
    handle(req, res).catch((err) => {
      log(`handler crash: ${err?.stack || err}`);
      try {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(`prism-proxy error: ${err?.message || err}`);
      } catch {}
    });
  });
  server.on("checkContinue", (req, res) => {
    try { res.writeContinue(); } catch {}
    handle(req, res).catch(() => {});
  });
  server.on("clientError", (err, socket) => {
    try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
  });

  let listenRetryTimer = null;
  let shuttingDown = false;
  const scheduleListenRetry = () => {
    if (shuttingDown || listenRetryTimer) return;
    listenRetryTimer = setTimeout(() => { listenRetryTimer = null; if (!shuttingDown) listen(); }, 5000);
    try { listenRetryTimer.unref?.(); } catch {}
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (listenRetryTimer) { clearTimeout(listenRetryTimer); listenRetryTimer = null; }
    try { server.closeAllConnections?.(); } catch {}
    try { server.close(() => {}); } catch {}
  };
  server.__prismShutdown = shutdown;

  // OpenCode loads a plugin once per open location, and again on every config
  // reload. Killing the previous instance here would drop streams that are in
  // flight (a compaction or a long turn dies as a provider error), so the first
  // live instance keeps serving and later setup() calls become no-ops.
  // Consequence: updating plugin code needs a service restart, not a reload.
  const existing = globalThis.__prismProxyServer;
  if (existing && existing.listening && existing.__prismPort === port) {
    log(`reusing the running instance on port ${port} (a reload does not restart it)`);
    return;
  }
  // Only the copy that will serve loads the state files. A duplicate copy stops
  // above and never reads or writes them.
  loadUsage();
  loadKeys();
  globalThis.__prismProxyServer = server;
  server.__prismPort = port;

  const listen = () => {
    if (shuttingDown) return;
    server.listen(port, LISTEN_HOST, () => {
      if (listenRetryTimer) { clearTimeout(listenRetryTimer); listenRetryTimer = null; }
      const lim = [...LIMITS].filter(([k]) => k !== "*")
        .map(([k, v]) => `${k}=${v.max}/${v.windowMs / 1000}s`).join(" ");
      log(`listening (${mode}) on http://${LISTEN_HOST}:${port} -> ${UPSTREAM.href}`);
      log(`limits: ${lim || "none"}${LIMIT_FALLBACK ? ` (fallback ${LIMIT_FALLBACK.max}/${LIMIT_FALLBACK.windowMs / 1000}s)` : ""}`);
      log(`vision: ${VISION_ENABLED ? `on model=${VISION_MODEL} targets=${VISION_TARGETS.join(",")}` : "off"}`);
      log(`compaction: ${COMPACTION_ENABLED ? `on handoff=${COMPACTION_MODEL} minPrompt=${COMPACTION_MIN_CHARS} chars` : "off"}`);
    });
  };
  server.on("error", (err) => {
    if (shuttingDown) return;
    if (err && err.code === "EADDRINUSE") {
      log(`port ${port} busy — retrying every 5s`);
      scheduleListenRetry();
    } else {
      log(`server error: ${err?.stack || err}`);
    }
  });
  listen();

  if (!globalThis.__prismProxyCrashGuards) {
    globalThis.__prismProxyCrashGuards = true;
    process.on("unhandledRejection", (reason) => {
      try { log(`swallowed unhandledRejection: ${(reason && (reason.stack || reason.message)) || reason}`); } catch {}
    });
    process.on("uncaughtException", (err) => {
      try { log(`swallowed uncaughtException: ${(err && (err.stack || err.message)) || err}`); } catch {}
    });
  }
}

// Swap in new code without restarting the OpenCode service. The new index.js is
// imported and checked FIRST: if it fails to load, the running proxy is left
// exactly as it was. Only then does the old copy stop taking new connections (the
// requests it already has run to completion on the old code) and the new copy
// bind the same port.
//
// What carries over: keys, pins and usage history (files). What does not: the
// in-memory rate windows, which start empty, so the first minute after a reload
// can send a little more than a key's cap upstream; the 429 retry absorbs that.
async function hotReload() {
  const old = globalThis.__prismProxyServer;
  if (!old) { log("hot reload: nothing is running to replace"); return false; }

  // Load the new code from a uniquely named copy. A "?reload=" query is not
  // enough: Bun, which runs the OpenCode host, can hand back the module it already
  // has for the same file, and the "new" copy would then be the old code.
  const copy = path.join(HOME_DIR, `.prism-reload-${Date.now()}.mjs`);
  let mod;
  globalThis.__prismHotReloading = true; // stops the new copy auto-starting itself
  try {
    fs.copyFileSync(ENTRY_FILE, copy);
    mod = await import(pathToFileURL(copy).href);
  } catch (e) {
    log(`hot reload aborted: the new index.js did not load (${e?.message || e}); still serving the old code`);
    return false;
  } finally {
    globalThis.__prismHotReloading = false;
    try { fs.unlinkSync(copy); } catch {} // already loaded into memory
  }
  if (typeof mod?.default?.setup !== "function") {
    log("hot reload aborted: the new index.js has no plugin entry; still serving the old code");
    return false;
  }

  log("hot reload: handing the port to the new code");
  saveKeys();
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify({ since: usage.since, lifetime: usage.lifetime })); } catch {}
  retired = true;
  // Requests already being served finish on this copy, and then close their
  // connection (headers not sent yet can still carry the instruction).
  for (const r of activeResponses) {
    try { if (!r.headersSent) r.setHeader("connection", "close"); } catch {}
  }
  globalThis.__prismProxyServer = null;
  try { old.close(); } catch {}              // stop listening, keep in-flight requests
  // Keep-alive sockets that were busy at this moment become idle when their
  // request finishes, and would otherwise stay attached to the old copy for good.
  // Sweep them for a while so clients move to the new copy.
  const sweep = () => { try { old.closeIdleConnections?.(); } catch {} };
  sweep();
  const sweeper = setInterval(sweep, 250);
  try { sweeper.unref?.(); } catch {}
  setTimeout(() => clearInterval(sweeper), 60000).unref?.();
  // Give the listening socket a moment to release, so the new copy binds on the
  // first try. If it still races, the bind retry (every 5s) picks it up.
  await new Promise((r) => setTimeout(r, 300));
  try {
    await mod.default.setup({});
  } catch (e) {
    log(`hot reload: the new copy failed to start: ${e?.stack || e}`);
    return false;
  }
  return true;
}

export default {
  id: "prism-proxy",
  async setup(ctx) {
    startServer(Number(process.env.PRISM_PROXY_PORT) || PORT_DEFAULT, "plugin")
      .catch((e) => log(`startServer failed: ${e?.stack || e}`));
  },
};

// Runs as a standalone daemon (`node index.js`, `bun index.js`) as well as a plugin.
const invokedDirectly = import.meta.main === true ||
  (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
// A hot reload re-imports this file; the flag stops that copy from also starting
// itself as a standalone server (hotReload starts it through setup()).
if (invokedDirectly && !globalThis.__prismHotReloading) {
  startServer(Number(process.env.PRISM_PROXY_PORT) || PORT_DEFAULT, "standalone")
    .catch((e) => log(`startServer failed: ${e?.stack || e}`));
}
