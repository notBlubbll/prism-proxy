// desktop-usage-panel — OpenCode Desktop GUI part.
//
// Adds a "Prism usage" tab to the session side region: summary cards, a
// per-model table with input/output/reasoning/cached tokens, average output
// TPS, average latency and estimated cost, plus a titled totals row. Windows:
// 24h / 7d / 30d / all. Data comes from the proxy's GET /usage endpoint.
//
// Loaded by the desktop from this prebuilt CommonJS bundle:
//   Function("require","module","exports", code)(sharedRequire, module, module.exports)
// `@opencode/plugin/gui` and `solid-js` are provided by the app at runtime.
//
// Plain DOM, no JSX and no build step: the panel builds its nodes once and
// updates them in place.
const { Plugin, Panel, MenuItem, Command, ComposerPill, Registry, Contract } = require("@opencode/plugin/gui");
const { createComponent, createEffect, createSignal, onCleanup } = require("solid-js");
const { insert } = require("solid-js/web");
const catalogRpc = { id: "prism-usage.catalog", events: {}, methods: {
  sync: { input: { type: "object", additionalProperties: false }, output: { type: "array", items: { type: "string" } } },
} };
const schedulingRpc = { id:'prism-usage.scheduling', events:{}, methods:{control:{input:{type:'object',required:['action','session'],properties:{action:{enum:['pause','resume','focus','unfocus']},session:{type:'string'},owner:{type:'string'}},additionalProperties:false},output:{type:'boolean'}}} };

// Live retry state from the proxy's /status, read by the composer pill. One
// signal for every window, refreshed once a second.
const [proxyStatus, setProxyStatus] = createSignal(null);

const WINDOWS = ["24u", "24h", "7d", "30d", "all"];

// Readable names for model ids. Unknown ids fall back to the id itself.
const MODEL_NAMES = {
  "claude-opus-4-5": "Claude Opus 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "grok-4.7": "Grok 4.7",
  "Kimi-K2.6": "Kimi K2.6",
  "Kimi-K2.7-Code": "Kimi K2.7 Code",
  "gpt-image-2": "GPT Image 2",
  "gpt-6.2-sol": "GPT-6.2 Sol",
  "gpt-6.2-astra": "GPT-6.2 Astra",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6.1-terra": "GPT-6.1 Terra",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-nano": "GPT-5.4 Nano",
  "gpt-5.1": "GPT-5.1",
  "gpt-5": "GPT-5",
  "gpt-4.1": "GPT-4.1",
  "gpt-4.1-mini": "GPT-4.1 Mini",
  "gpt-4.1-nano": "GPT-4.1 Nano",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-chat-latest": "GPT Chat Latest",
  "o3-mini": "o3-mini",
};
const displayModel = (id) => MODEL_NAMES[id] || String(id || "");
// Shown in place of a saved key. The real value is only fetched on Show.
const KEY_MASK = "••••••••••••••••";
const COLUMNS = [
  { key: "model", label: "Model", align: "left" },
  { key: "requests", label: "Req", align: "right" },
  { key: "input", label: "Uncached", align: "right", title: "Input tokens not served from cache" },
  { key: "cached", label: "Cached", align: "right", title: "Input tokens served from cache; hover for the cache-hit percentage" },
  { key: "output", label: "Out", align: "right" },
  { key: "reasoning", label: "Reason", align: "right" },
  { key: "avgTps", label: "tok/s", align: "right",
    title: "Decode speed: output tokens after the first one ÷ time between the first and last streamed token. Excludes time to first token, and replies under 16 tokens." },
  { key: "ttftMs", label: "ttft", align: "right",
    title: "Time to first token: from sending the request to the first streamed text, averaged." },
  { key: "avgMs", label: "avg", align: "right",
    title: "Average total request time, start to finish." },
  { key: "cost", label: "$", align: "right" },
];

function fmt(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

// Latencies are shown in seconds everywhere: 13888 ms reads as 13.888s, and
// anything under a second keeps three decimals so short calls stay readable.
function secs(ms) {
  const v = Number(ms) || 0;
  if (v <= 0) return "—";
  return (v / 1000).toFixed(3) + "s";
}

function inputBreakdown(stats) {
  const total = stats.input || 0;
  const measured = stats.inputReal ?? (stats.seeded ? 0 : total);
  const cached = Math.min(measured, stats.cachedReal ?? stats.cached ?? 0);
  const uncached = measured - cached;
  const unknown = Math.max(0, total - measured);
  const details = [`${total.toLocaleString()} total input`, `${uncached.toLocaleString()} uncached`, `${cached.toLocaleString()} cached`];
  if (measured) details.push(`${(100 * cached / measured).toFixed(1)}% cache hit rate on measured input`);
  if (unknown) details.push(`${unknown.toLocaleString()} input tokens with unknown cache status`);
  return { uncached, cached, unknown, title: details.join("\n") };
}

function tpsTitle(s) {
  if (!s || !s.avgTps) return "no streamed replies long enough to measure yet";
  return [
    `average ${s.avgTps} tok/s (all measured tokens ÷ all generation time)`,
    `mean of requests ${s.meanTps || 0} · median ${s.medTps || 0} · latest ${s.lastTps || 0}`,
    `${s.tpsN || 0} request(s) measured`,
  ].join("\n");
}

// "3m", "42s", "2h": how long a session has been quiet.
function idleText(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

function ttftTitle(s) {
  if (!s || !s.ttftMs) return "no streamed replies to measure yet";
  return `average over ${s.ttftN || 0} request(s)`;
}

function money(n) {
  const v = Number(n) || 0;
  if (v === 0) return "$0.00";
  if (v < 0.01) return "$" + v.toFixed(4);
  return "$" + v.toFixed(2);
}

const BORDER = "1px solid rgba(127,127,127,.18)";

function buildPanel(ui, endpoint, refreshMs, headingText, getSessionId, getSessionInfo, syncModels, control) {
  const sessionId = () => {
    try { return typeof getSessionId === "function" ? getSessionId() : null; } catch { return null; }
  };
  const infoOf = (id) => {
    try { return getSessionInfo?.(id); } catch { return null; }
  };
  const root = document.createElement("div");
  root.style.cssText = [
    "padding:14px",
    "font-family:inherit;font-size:12px;line-height:1.5",
    "color:inherit",
    "height:100%",
    "overflow:auto",
    "box-sizing:border-box",
    "container:prism-panel / inline-size",
    "width:100%;max-width:100%;min-width:0",
    "display:flex",
    "flex-direction:column",
    "gap:12px",
    // The app disables selection on chrome-like surfaces; keep the numbers
    // copyable with the mouse.
    "user-select:text",
    "-webkit-user-select:text",
    "cursor:auto",
  ].join(";");
  root.className = "prism-usage-panel";
  const style = document.createElement("style");
  style.textContent = `
    .prism-usage-panel > * { min-inline-size:0; }
    .prism-usage-panel .prism-table-scroll { overflow-x:auto; flex:none; }
    .prism-usage-panel .prism-icon-action { width:28px; height:28px; padding:0; display:inline-grid; place-items:center; color:inherit; background:transparent; border:0; border-radius:4px; cursor:pointer; }
    .prism-usage-panel .prism-icon-action:hover { background:var(--surface-base-hover,color-mix(in srgb,currentColor 8%,transparent)); }
    .prism-usage-panel .prism-title-toggle,.prism-usage-panel .prism-compact-forecast,.prism-usage-panel .prism-more-columns { display:none; }
    @container prism-panel (max-width:760px) {
      .prism-models:not([data-full]) :is(td,th):is(:nth-child(3),:nth-child(4),:nth-child(6),:nth-child(7),:nth-child(8),:nth-child(9)) { display:none; }
      .prism-models:not([data-full]) table { table-layout:fixed; }
      .prism-models:not([data-full]) :is(td,th):first-child { width:40%; }
      .prism-models:not([data-full]) :is(td,th) { overflow:hidden; text-overflow:ellipsis; }
      .prism-usage-panel .prism-more-columns { display:inline-flex; align-self:flex-start; }
      .prism-sessions :is(table,tbody,tr:not(.prism-session-row)),.prism-sessions .prism-group-cell { display:block; min-width:0; }
      .prism-sessions .prism-session-head { display:none !important; }
      .prism-session-row { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; border-bottom:1px solid var(--border-weak-base,rgba(127,127,127,.18)); padding-block:4px; }
      .prism-session-row > td { min-width:0; padding:0 4px !important; border:0 !important; }
      .prism-session-name { grid-area:1/1; max-width:none !important; }
      .prism-session-action { grid-area:1/2; }
      .prism-session-state { grid-area:2/1/auto/-1; white-space:normal !important; overflow-wrap:anywhere; }
      .prism-usage-panel .prism-compact-forecast { display:inline; opacity:.75; }
      .prism-session-name:has(.prism-title-toggle) > .prism-title { display:none; }
      .prism-usage-panel .prism-title-toggle { display:block; width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:start; font:inherit; color:inherit; border:0; background:transparent; padding:3px 0; cursor:pointer; }
      .prism-title-toggle::before { content:'›'; display:inline-block; margin-inline-end:6px; }
      .prism-title-toggle[aria-expanded=true]::before { transform:rotate(90deg); }
      .prism-session-row > [data-metric] { display:none; }
      .prism-session-row[data-expanded] > [data-metric] { display:block; grid-column:1/-1; text-align:start !important; max-width:none !important; white-space:normal !important; overflow-wrap:anywhere; }
      .prism-session-row [data-metric]::before { content:attr(data-metric) ': '; opacity:.7; }
    }
    .prism-usage-panel .prism-unused { flex:none; }
    .prism-usage-panel .prism-unused-list { --row-height:2em; max-block-size:calc(7 * var(--row-height)); overflow-y:auto; list-style:none; margin:0; padding:0; }
    .prism-usage-panel .prism-unused-list li { display:flex; align-items:center; justify-content:space-between; gap:8px; height:var(--row-height); }
    .prism-usage-panel .prism-unused-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    @media (prefers-reduced-motion:no-preference) {
      @supports (interpolate-size:allow-keywords) and selector(details::details-content) {
        .prism-usage-panel .prism-unused::details-content { interpolate-size:allow-keywords; block-size:0; overflow:clip; opacity:0; transition:block-size 180ms ease-out, opacity 140ms ease-out, content-visibility 180ms allow-discrete; }
        .prism-usage-panel .prism-unused[open]::details-content { block-size:auto; opacity:1; }
      }
    }
    .prism-usage-panel .prism-live-rates { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:8px 16px; }
    .prism-usage-panel .prism-rate { display:grid; grid-template-columns:auto 1fr; align-items:baseline; gap:3px 6px; }
    .prism-usage-panel .prism-rate span:last-of-type { text-align:end; font-variant-numeric:tabular-nums; }
    .prism-usage-panel .prism-rate-track { position:relative; grid-column:1/-1; height:4px; overflow:hidden; border-radius:2px; background:color-mix(in srgb,currentColor 13%,transparent); }
    .prism-usage-panel .prism-rate-track::after { content:""; position:absolute; inset:0; background:currentColor; transform-origin:left center; transform:scaleX(var(--rate-fill,0)); }
    .prism-usage-panel .prism-rate-track meter { position:absolute; width:1px; height:1px; clip-path:inset(50%); }
    @media (prefers-reduced-motion:no-preference) {
      .prism-usage-panel .prism-rate-track::after { transition:transform 240ms cubic-bezier(.22,1,.36,1); }
    }
    .prism-usage-panel .prism-ranges { position:relative; display:inline-grid; grid-auto-flow:column; grid-auto-columns:1fr; }
    .prism-usage-panel .prism-ranges::after { content:""; position:absolute; pointer-events:none; left:0; bottom:0; width:calc(100% / var(--range-count)); height:2px; background:currentColor; border-radius:2px; transform:translateX(calc(var(--range-index,0) * 100%)) scaleX(.52); }
    @media (prefers-reduced-motion:no-preference) {
      .prism-usage-panel .prism-ranges[data-animate]::after { transition:transform 160ms cubic-bezier(.22,1,.36,1); }
    }
    .prism-usage-panel .prism-range, .prism-usage-panel .prism-key-heading { font:inherit; color:inherit; border:none; border-radius:4px; background:transparent; cursor:pointer; }
    .prism-usage-panel .prism-range { padding:4px 6px; white-space:nowrap; color:var(--text-weak,inherit); }
    .prism-usage-panel .prism-key-heading:hover { background:var(--surface-base-hover,color-mix(in srgb,currentColor 8%,transparent)); }
    .prism-usage-panel .prism-range:hover, .prism-usage-panel .prism-range[aria-pressed="true"] { color:inherit; }
    .prism-usage-panel :is(button,input,select):focus-visible { outline:2px solid var(--border-focus,currentColor); outline-offset:1px; }
    .prism-usage-panel .prism-key-heading { display:flex; align-items:center; gap:6px; padding:5px 4px; text-align:start; font-weight:600; }
  `;
  root.appendChild(style);
  function iconAction(label, props) {
    const slot = document.createElement("span");
    slot.style.display = "inline-flex";
    insert(slot, createComponent(ui.Tooltip, {
      get value() { return label(); },
      get children() { return createComponent(ui.IconButton, props); },
    }));
    return slot;
  }

  // ---- header -------------------------------------------------------------
  const head = document.createElement("div");
  head.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap";

  const heading = document.createElement("div");
  heading.textContent = headingText || "Usage";
  heading.style.cssText = "font-weight:650;font-size:13px;letter-spacing:.01em";
  head.appendChild(heading);
  const pacing = document.createElement("span");
  // Base wrapping on the available panel width, never on the changing countdown text.
  pacing.style.cssText = "flex:1 1 8rem;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--text-weak,inherit);font-variant-numeric:tabular-nums";
  head.appendChild(pacing);

  let win = "24u";
  const buttons = {};
  const ranges = document.createElement("div");
  ranges.className = "prism-ranges";
  ranges.style.setProperty("--range-count", WINDOWS.length);
  ranges.setAttribute("role", "group");
  ranges.setAttribute("aria-label", "Usage time range");
  head.appendChild(ranges);
  for (const w of WINDOWS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = w === "24u" ? "Today" : w === "all" ? "All" : w;
    if (w === "24u") b.title = "Since midnight UTC";
    if (w === "24h") b.title = "Last 24 hours";
    b.className = "prism-range";
    b.onclick = (event) => {
      if (win === w) return;
      win = w;
      ranges.toggleAttribute("data-animate", event.detail > 0);
      ranges.style.setProperty("--range-index", WINDOWS.indexOf(w));
      paint();
    };
    buttons[w] = b;
    ranges.appendChild(b);
  }

  // Key filter next to the window pills: "all" (combined, the default) or one key.
  const [keyView, setKeyView] = createSignal("all");
  const waitLabels = {
    "session-budget": "Saving room for sessions",
    "rpm-pacing": "Spacing requests · RPM", "tpm-pacing": "Spacing requests · TPM",
    "rpm-limit": "Waiting for RPM", "tpm-limit": "Waiting for TPM", upstream: "Upstream cooldown",
  };
  createEffect(() => {
    const status = proxyStatus();
    const threshold = status?.globalLimits?.paceStartPercent;
    if (threshold == null) {
      pacing.textContent = "Pacing unavailable";
      pacing.title = "No live pacing report from the proxy";
      return;
    }
    const active = Object.entries(status.global || {}).filter(([slot, state]) =>
      (keyView() === "all" || slot === `global|${keyView()}`) && state.wait?.remainingMs > 0
    );
    const sampledAt = status.updated ?? Date.now();
    function updateLabel() {
      const elapsed = Math.max(0, Date.now() - sampledAt);
      const waits = active.map(([slot, state]) => {
        const key = status.keys > 1 ? `Key ${slot.split("|")[1] || "default"}: ` : "";
        const { reason, releaseAmount, remainingMs } = state.wait;
        if (elapsed >= remainingMs) return `${key}Rechecking capacity…`;
        const seconds = `${(Math.ceil((remainingMs - elapsed) / 100) / 10).toFixed(1)}s`;
        const unit = reason.startsWith("tpm") || reason === "session-budget" ? "tokens" : releaseAmount === 1 ? "slot" : "slots";
        const detail = releaseAmount > 0 ? `${fmt(releaseAmount)} ${unit} free in ${seconds}` : seconds;
        return `${key}${waitLabels[reason] || "Waiting"} · ${detail}`;
      });
      const off = threshold >= 100 || (status.globalLimits.requests === "off" && status.globalLimits.tokens === "off");
      pacing.textContent = waits.length ? waits[0] + (waits.length > 1 ? ` (+${waits.length - 1})` : "") : off ? "Pacing off" : "No pacing delay";
      pacing.title = waits.length ? waits.join("\n") : off ? "Adaptive pacing is disabled" : `Adaptive pacing starts above ${threshold}% of a key’s RPM or TPM limit`;
    }
    updateLabel();
    if (active.length) {
      const timer = setInterval(updateLabel, 100);
      onCleanup(() => clearInterval(timer));
    }
  });
  const keyFilterBox = document.createElement("span");
  keyFilterBox.style.cssText = "display:inline-flex;gap:4px;margin-left:6px;padding-left:8px;border-left:" + BORDER;
  const keySelect = document.createElement("select");
  keySelect.setAttribute("aria-label", "Usage for key");
  keySelect.style.cssText = [
    "padding:3px 8px", "border-radius:999px", "border:1px solid rgba(127,127,127,.3)",
    "background:transparent", "color:inherit", "cursor:pointer", "font:inherit", "line-height:1.5",
  ].join(";");
  keySelect.onchange = () => { setKeyView(keySelect.value); paint(); };
  keyFilterBox.appendChild(keySelect);
  let keyOptionsSig = "";
  function renderKeyFilter() {
    if (keys.length < 2) {
      setKeyView("all");
      keyFilterBox.remove();
      return;
    }
    if (!keyFilterBox.parentNode) head.insertBefore(keyFilterBox, refreshBtn);
    const ids = ["all", ...keys.map((k) => String(k.index))];
    if (!ids.includes(keyView())) setKeyView("all");
    const sig = ids.join(",");
    if (sig !== keyOptionsSig) {
      keyOptionsSig = sig;
      keySelect.textContent = "";
      for (const id of ids) {
        const o = document.createElement("option");
        o.value = id;
        o.textContent = id === "all" ? "all keys" : "key " + id;
        keySelect.appendChild(o);
      }
    }
    keySelect.value = keyView();
  }

  const [refreshing, setRefreshing] = createSignal(false);
  const refreshBtn = iconAction(() => "Refresh usage", {
    icon: "refresh", label: "Refresh usage", variant: "ghost", size: "small",
    get busy() { return refreshing(); }, onClick: () => refresh(),
  });
  head.appendChild(refreshBtn);
  root.appendChild(head);

  const live = document.createElement("section");
  live.setAttribute("aria-label", "Live rate limits");
  const caption = document.createElement("strong");
  caption.textContent = "Live rate limits";
  const rates = document.createElement("div");
  rates.className = "prism-live-rates";
  live.append(caption, rates);
  root.appendChild(live);
  const rateRows = new Map();
  createEffect(() => {
    const status = proxyStatus();
    if (!status?.globalLimits || !status.global) {
      rates.textContent = "Live counters unavailable";
      rateRows.clear();
      return;
    }
    const count = Math.max(1, status.keys || 1);
    const visible = new Set();
    for (let slot = 1; slot <= count; slot++) {
      if (keyView() !== "all" && keyView() !== String(slot)) continue;
      const snapshot = status.global[`global|${slot}`] ?? (count === 1 ? status.global.global : undefined);
      for (const [name, kind, field] of [["RPM", "requests", "used"], ["TPM", "tokens", "tokensUsed"]]) {
        const limit = /^(\d+)\/([\d.]+)s$/.exec(status.globalLimits[kind]);
        const label = limit && Number(limit[2]) !== 60 ? `${kind} / ${limit[2]}s` : name;
        const title = count > 1 ? `Key ${slot} · ${label}` : label;
        visible.add(title);
        if (!rateRows.has(title)) {
          const row = document.createElement("div");
          row.className = "prism-rate";
          const heading = document.createElement("span");
          heading.textContent = title;
          const value = document.createElement("span");
          const meter = document.createElement("meter");
          meter.setAttribute("aria-label", title);
          const track = document.createElement("div");
          track.className = "prism-rate-track";
          track.appendChild(meter);
          row.append(heading, value, track);
          rateRows.set(title, { row, value, meter, track });
        }
        const { row, value, meter, track } = rateRows.get(title);
        track.hidden = !limit;
        if (!limit) {
          row.removeAttribute("title");
          value.textContent = status.globalLimits[kind] === "off" ? "Off" : "Unavailable";
          continue;
        }
        const cap = Number(limit[1]) / count;
        const used = snapshot?.[field] ?? 0;
        meter.max = cap;
        meter.value = used;
        track.style.setProperty("--rate-fill", meter.value / meter.max);
        row.title = `${used.toLocaleString()} of ${cap.toLocaleString()} ${kind} in the last ${limit[2]} seconds`;
        meter.setAttribute("aria-valuetext", row.title);
        value.textContent = `${fmt(used)} / ${fmt(cap)}`;
      }
    }
    const rows = Array.from(visible, title => rateRows.get(title).row);
    if (rates.childNodes.length !== rows.length || rows.some((row, i) => rates.children[i] !== row)) {
      rates.replaceChildren(...rows);
      for (const title of rateRows.keys()) if (!visible.has(title)) rateRows.delete(title);
    }
  });

  // ---- summary cards ------------------------------------------------------
  const cards = document.createElement("div");
  cards.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px";
  root.appendChild(cards);

  const cardValues = {};
  for (const [key, label] of [["requests", "Requests"], ["input", "Uncached input"], ["cached", "Cached input"], ["output", "Output"], ["cost", "Cost"]]) {
    const card = document.createElement("div");
    card.style.cssText = [
      "padding:9px 11px",
      "border-radius:9px",
      "background:rgba(127,127,127,.08)",
      "border:" + BORDER,
      "min-width:0",
    ].join(";");
    const k = document.createElement("div");
    k.textContent = label;
    k.style.cssText = "font-size:10px;letter-spacing:.06em;text-transform:uppercase;opacity:.55";
    const v = document.createElement("div");
    v.textContent = "—";
    v.style.cssText = "font-size:16px;font-weight:650;margin-top:3px;font-variant-numeric:tabular-nums;white-space:nowrap";
    card.appendChild(k);
    card.appendChild(v);
    cards.appendChild(card);
    cardValues[key] = v;
  }

  // ---- table --------------------------------------------------------------
  const table = document.createElement("table");
  table.style.cssText = "width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;user-select:text;-webkit-user-select:text";
  const modelScroll = document.createElement('div');
  modelScroll.className = 'prism-models prism-table-scroll';
  modelScroll.appendChild(table);
  const columnsButton = document.createElement('button');
  columnsButton.className = 'prism-range prism-more-columns';
  columnsButton.type = 'button';
  columnsButton.textContent = 'Show all columns';
  columnsButton.setAttribute('aria-expanded','false');
  columnsButton.onclick = () => {
    const full = modelScroll.toggleAttribute('data-full');
    columnsButton.textContent = full ? 'Show fewer columns' : 'Show all columns';
    columnsButton.setAttribute('aria-expanded', String(full));
  };
  root.append(modelScroll, columnsButton);

  const unused = document.createElement("details");
  unused.className = "prism-unused";
  const unusedHeading = document.createElement("summary");
  unusedHeading.textContent = "Unused models";
  unusedHeading.style.cssText = "cursor:pointer;font-weight:600";
  const tools = document.createElement("div");
  tools.style.cssText = "display:flex;gap:8px;align-items:center;margin:8px 0";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search unused models…";
  search.setAttribute("aria-label", "Search unused models");
  search.style.cssText = "min-width:0;flex:1;font:inherit;color:inherit;background:transparent;border:" + BORDER + ";border-radius:5px;padding:4px 8px";
  tools.appendChild(search);
  const [syncing, setSyncing] = createSignal(false);
  insert(tools, createComponent(ui.Button, {
    children: "Sync models", size: "small", variant: "ghost", type: "button",
    get busy() { return syncing(); }, get disabled() { return syncing(); }, onClick: () => syncCatalog(),
  }));
  const catalogNote = document.createElement("div");
  catalogNote.setAttribute("role", "status");
  const unusedList = document.createElement("ul");
  unusedList.className = "prism-unused-list";
  unusedList.setAttribute("aria-label", "Unused model results");
  unused.append(unusedHeading, tools, catalogNote, unusedList);
  root.appendChild(unused);

  let catalog = null;
  let catalogDue = 0;
  let catalogError = false;
  let usedIds = null;
  let lastList = "";
  function showUnused() {
    const ids = catalog && usedIds ? catalog.filter(id => !usedIds.has(id)) : null;
    unusedHeading.textContent = ids ? `Unused models (${ids.length})` : "Unused models";
    if (!unused.open) return;
    const query = search.value.trim().toLowerCase();
    const matches = (ids || []).filter(id => `${id} ${displayModel(id)}`.toLowerCase().includes(query));
    const notes = [];
    if (catalogError) notes.push(catalog ? "Sync failed. Showing last synced catalog." : "Model catalog unavailable.");
    if (!usedIds) notes.push("Waiting for usage data.");
    else if (!catalog && !catalogError) notes.push("Loading model catalog…");
    else if (ids && !matches.length) notes.push(query ? "No matching unused models." : "No unused models in this range.");
    catalogNote.textContent = notes.join(" ");
    const signature = JSON.stringify(matches);
    if (signature === lastList) return;
    lastList = signature;
    unusedList.replaceChildren(...matches.map(id => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "prism-unused-name";
      name.textContent = id;
      name.title = id;
      const count = document.createElement("span");
      count.style.whiteSpace = "nowrap";
      count.textContent = "0 requests";
      item.append(name, count);
      return item;
    }));
  }
  search.oninput = unused.ontoggle = showUnused;
  const catalogAbort = new AbortController();
  async function syncCatalog() {
    if (syncing() || catalogAbort.signal.aborted) return;
    setSyncing(true);
    try {
      catalog = await syncModels();
      catalogError = false;
    } catch { catalogError = true; }
    finally {
      catalogDue = Date.now() + (catalogError ? 60000 : 15 * 60000);
      setSyncing(false);
      if (!catalogAbort.signal.aborted) showUnused();
    }
  }

  const footer = document.createElement("div");
  footer.style.cssText = "margin-top:auto;padding-top:6px;opacity:.5;font-size:11px";
  root.appendChild(footer);

  // ---- sessions ------------------------------------------------------------
  // Who is using which key right now. One session is glued to one key, so this is
  // also the answer to "which key is busy".
  let sessions = [];
  const sessionsBox = document.createElement("div");
  sessionsBox.style.cssText = "border-top:" + BORDER + ";padding-top:10px;display:flex;flex-direction:column;gap:6px";
  const sessionsHead = document.createElement("div");
  sessionsHead.textContent = "Sessions";
  sessionsHead.style.cssText = "font-size:11px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;opacity:.55";
  const sessionsList = document.createElement("div");
  sessionsList.style.cssText = "display:flex;flex-direction:column;gap:3px";
  sessionsBox.appendChild(sessionsHead);
  sessionsBox.appendChild(sessionsList);
  // Sits between the table and the footer, i.e. in the middle of the panel.
  root.insertBefore(sessionsBox, footer);
  const errorsBox = document.createElement("details");
  errorsBox.className = "prism-unused";
  const errorsHeading = document.createElement("summary");
  errorsHeading.style.cursor = "pointer";
  const errorsList = document.createElement("ul");
  errorsList.className = "prism-unused-list";
  errorsBox.append(errorsHeading, errorsList);
  root.insertBefore(errorsBox, footer);
  let errorsSignature;
  createEffect(() => {
    const errors = proxyStatus()?.recentErrors || [];
    const signature = JSON.stringify(errors);
    if (signature === errorsSignature) return;
    errorsSignature = signature;
    errorsBox.hidden = !errors.length;
    errorsHeading.textContent = errors.length ? `Recent errors (${errors.length}) · HTTP ${errors[0].status}` : "Recent errors";
    errorsList.replaceChildren(...errors.map(error => {
      const row = document.createElement("li");
      row.textContent = `${new Date(error.at).toLocaleTimeString()} · HTTP ${error.status} · ${displayModel(error.model)}`;
      row.title = error.sessionID ? infoOf(error.sessionID)?.title || error.sessionID : "Upstream HTTP response";
      return row;
    }));
  });
  const expandedAgents = new Set();
  const expandedMetrics = new Set();
  const controlNote = document.createElement('div');
  controlNote.setAttribute('role','status');
  sessionsBox.appendChild(controlNote);

  function renderSessions() {
    const focusedGroup = sessionsList.contains(document.activeElement) && document.activeElement.dataset.agentGroup;
    const focusedAction = sessionsList.contains(document.activeElement) && document.activeElement.dataset.sessionControl;
    const focusedTitle = sessionsList.contains(document.activeElement) && document.activeElement.dataset.metricsFor;
    sessionsList.textContent = "";
    if (!sessions.length) {
      const empty = document.createElement("div");
      empty.textContent = "no sessions in the last 30 minutes";
      empty.style.cssText = "opacity:.5;font-size:11px";
      sessionsList.appendChild(empty);
      return;
    }
    const here = sessionId();
    const tbl = document.createElement("table");
    sessionsList.classList.add('prism-sessions','prism-table-scroll');
    tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;user-select:text;-webkit-user-select:text;cursor:text";
    const head = document.createElement("tr");
    head.className = 'prism-session-head';
    head.appendChild(th("Session", "left"));
    head.appendChild(th("Key", "center", "the key this session is pinned to; all its requests use that key's limits"));
    head.appendChild(th("Model", "left"));
    head.appendChild(th("Req", "right", "requests this session sent in the last minute / its key's per-minute cap for the model. Empty once the minute has passed."));
    head.appendChild(th("TPM", "right", "tokens this session used in the last minute, as a share of its key's per-minute token cap for the model. Empty once the minute has passed."));
    head.appendChild(th("State", "left", "Running sessions, including nested subagents. Each session counts once."));
    head.appendChild(th("Forecast", "right", "Estimated token budget for the next request, not billed usage"));
    head.appendChild(th("Schedule", "left"));
    tbl.appendChild(head);

    const nodes = new Map(sessions.map(s => [s.id, { id: s.id, usage: s, info: infoOf(s.id), children: [] }]));
    const roots = [];
    for (const node of nodes.values()) {
      const parentID = node.info?.parentID || node.usage?.parentID;
      if (!parentID || parentID === node.id || node.info?.fork) { roots.push(node); continue; }
      if (!nodes.has(parentID)) nodes.set(parentID, { id: parentID, info: infoOf(parentID), children: [] });
      nodes.get(parentID).children.push(node);
    }
    for (const id of expandedAgents) if (!nodes.get(id)?.children.length) expandedAgents.delete(id);

    function sortSessions(list) {
      for (const node of list) {
        sortSessions(node.children);
        const s = node.usage;
        node.queued = (s?.queued || 0) + node.children.reduce((total,child) => total + child.queued, 0);
        node.rank = s?.sending || (s?.active && !s?.heldBy) ? 0 : s?.heldBy ? 1 : 2;
        node.size = s?.forecast || s?.contextTokens || Infinity;
        const child = node.children[0];
        if (child && (child.rank < node.rank || (child.rank === node.rank && child.size < node.size))) {
          node.rank = child.rank; node.size = child.size;
        }
      }
      list.sort((a,b) => a.rank - b.rank || a.size - b.size || a.id.localeCompare(b.id));
    }
    sortSessions(roots);

    function appendSession(node, target, last) {
      const s = node.usage;
      const tr = document.createElement("tr");
      tr.title = node.id;
      tr.className = 'prism-session-row';

      const title = node.info?.title || node.info?.name || `${node.id.slice(0, 8)}…${node.id.slice(-4)}`;
      const name = td(title + (node.id === here ? "  · this one" : ""), "left", { last, strong: node.id === here, model: true });
      name.className = 'prism-session-name';
      const label = document.createElement('span');
      label.className = 'prism-title';
      label.textContent = name.textContent;
      name.replaceChildren(label);
      if (s) {
        const toggle = document.createElement('button');
        toggle.className = 'prism-title-toggle'; toggle.type = 'button'; toggle.dataset.metricsFor = node.id;
        toggle.textContent = label.textContent;
        toggle.title = `${title} — session details`;
        function paintDetails(open) {
          tr.toggleAttribute('data-expanded', open);
          toggle.setAttribute('aria-expanded', String(open));
        }
        paintDetails(expandedMetrics.has(node.id));
        toggle.onclick = () => {
          const open = !expandedMetrics.has(node.id);
          if (open) expandedMetrics.add(node.id); else expandedMetrics.delete(node.id);
          paintDetails(open);
        };
        name.appendChild(toggle);
      }
      name.title = s?.contextTokens != null ? `${node.id}\nLast reported session context: ${s.contextTokens.toLocaleString()} tokens (input + output)` : node.id;
      tr.appendChild(name);
      target.appendChild(tr);
      if (s) appendSessionMetrics(tr, s, last);
      else name.colSpan = 5;
      let running = (s?.sending ?? s?.active) > 0 ? 1 : 0;
      if (!node.children.length) {
        appendState(tr, running, node, last);
        return running;
      }
      const groupRow = target.insertRow();
      const cell = groupRow.insertCell();
      cell.className = 'prism-group-cell';
      cell.colSpan = 8;
      cell.style.paddingInlineStart = "12px";
      const group = document.createElement("details");
      group.className = "prism-unused";
      const toggle = document.createElement("summary");
      toggle.style.cssText = "cursor:pointer;padding:3px 0";
      toggle.dataset.agentGroup = node.id;
      toggle.textContent = `Subagents (${node.children.length})`;
      group.open = expandedAgents.has(node.id);
      group.ontoggle = () => {
        if (!group.isConnected) return;
        if (group.open) expandedAgents.add(node.id); else expandedAgents.delete(node.id);
      };
      const scroll = document.createElement("div");
      scroll.style.cssText = "max-height:14rem;overflow:auto";
      const subtable = document.createElement("table");
      subtable.style.cssText = tbl.style.cssText;
      subtable.setAttribute("aria-label", `Subagents of ${title}`);
      subtable.appendChild(head.cloneNode(true));
      node.children.forEach((child, i) => { running += appendSession(child, subtable, i === node.children.length - 1); });
      scroll.appendChild(subtable);
      group.append(toggle, scroll);
      cell.appendChild(group);
      appendState(tr, running, node, last);
      return running;
    }

    function appendSessionMetrics(tr, s, last) {

      tr.appendChild(td(s.key ? `Key ${s.key}` : "no key", "center", { last, muted: !s.key, strong: s.active > 0 }));

      // A session that overflowed shows the model actually serving it, with a *
      // and the model it was meant for in the tooltip.
      const spilled = !!s.from && !!s.model;
      tr.appendChild(td(s.model ? displayModel(s.model) + (spilled ? " *" : "") : "–", "left", {
        last, muted: !s.model, model: true,
        title: spilled ? `overflow: ${displayModel(s.from)} was full, so this session's request runs on ${displayModel(s.model)} (${s.model})` : (s.model || ""),
      }));

      const lim = s.limit;
      // Both figures are rolling-minute counts that the proxy recomputes on every
      // poll, so they empty by themselves as requests age out of the window.
      const reqShown = !!lim && lim.max > 0 && lim.used > 0;
      tr.appendChild(td(reqShown ? `${lim.used}/${lim.max}` : "–", "right", {
        last, muted: !reqShown, strong: reqShown && lim.used >= lim.max,
        title: lim && lim.max > 0
          ? `this session: ${lim.used} of ${lim.max} requests in the last ${Math.round(lim.windowMs / 1000)}s on Key ${s.key} (${s.model})\n` +
            `everyone on Key ${s.key}: ${lim.keyUsed} of ${lim.max}`
          : "",
      }));

      const tpmShown = !!lim && lim.tokenMax > 0 && lim.tokens > 0;
      const tpm = tpmShown ? (lim.tokens / lim.tokenMax) * 100 : 0;
      tr.appendChild(td(tpmShown ? `${tpm < 10 ? tpm.toFixed(1) : Math.round(tpm)}%` : "–", "right", {
        last, muted: !tpmShown, strong: tpmShown && tpm >= 100,
        title: lim && lim.tokenMax > 0
          ? `this session: ${lim.tokens.toLocaleString()} of ${lim.tokenMax.toLocaleString()} tokens in the last ${Math.round(lim.tokenWindowMs / 1000)}s on Key ${s.key} (${s.model})\n` +
            `everyone on Key ${s.key}: ${lim.keyTokens.toLocaleString()} (${((lim.keyTokens / lim.tokenMax) * 100).toFixed(1)}%)`
          : "",
       }));

      ['Key','Model','Requests','TPM'].forEach((label,i) => { tr.cells[i+1].dataset.metric = label; });

    }

    function appendState(tr, running, node, last) {
      const s = node.usage;
      const state = td("", "left", { last });
      state.className = 'prism-session-state';
      if (running > 0) {
        state.textContent = `● ${running} running`;
        state.style.color = "rgb(80,170,110)";
        state.style.fontWeight = "650";
      } else {
        state.textContent = s ? `idle ${idleText(s.idleMs)}` : "–";
        state.style.opacity = ".5";
      }
      state.style.fontVariantNumeric = "tabular-nums";
      const heldBy = s?.heldBy || (node.children.find(c=>c.usage?.heldBy===node.id) ? node.id : null);
      const flags = [];
      if (heldBy) flags.push('Paused');
      if (node.queued) flags.push(`${node.queued} queued`);
      if (s?.next) flags.push('Next on this key');
      if (s?.wait) flags.push(waitLabels[s.wait.reason] || 'Waiting for capacity');
      if (s?.background) flags.push('Background');
      if (flags.length) { state.textContent = (running ? `${running} running · ` : '') + flags.join(' · '); state.style.opacity = '1'; }
      tr.appendChild(state);
      const forecast = td(s?.forecast ? fmt(s.forecast) : '–','right',{last});
      forecast.dataset.metric = 'Forecast';
      tr.appendChild(forecast);
      if (s?.forecast && (s.active || s.queued)) {
        const brief = document.createElement('span');
        brief.className = 'prism-compact-forecast';
        brief.textContent = ` · ${fmt(s.forecast)} forecast`;
        state.appendChild(brief);
      }
      const action = td('', 'left', { last });
      action.className = 'prism-session-action';
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'prism-icon-action'; button.dataset.sessionControl = node.id;
      const actionLabel = !heldBy ? 'Pause session and subagents' : heldBy === node.id ? 'Resume session and subagents' : 'Resume parent session and subagents';
      button.setAttribute('aria-label', actionLabel);
      button.title = heldBy ? actionLabel : `${actionLabel} — resumes automatically within 60s`;
      const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 16 16'); svg.setAttribute('width','16'); svg.setAttribute('height','16'); svg.setAttribute('aria-hidden','true');
      const path = document.createElementNS(svg.namespaceURI,'path');
      path.setAttribute('fill','currentColor');
      path.setAttribute('d', heldBy ? 'M5 3.3v9.4L12.4 8z' : 'M4 3h2.5v10H4zm5.5 0H12v10H9.5z');
      svg.appendChild(path); button.appendChild(svg);
      button.onclick = async () => {
        button.disabled = true;
        try { await control(heldBy ? 'resume' : 'pause', heldBy || node.id); controlNote.textContent = ''; await refresh(); }
        catch { controlNote.textContent = 'Could not update scheduling. Try again.'; }
        finally { button.disabled = false; }
      };
      action.appendChild(button); tr.appendChild(action);

    }
    roots.forEach((node, i) => appendSession(node, tbl, i === roots.length - 1));
    sessionsList.appendChild(tbl);
    if (focusedGroup) sessionsList.querySelector(`summary[data-agent-group="${CSS.escape(focusedGroup)}"]`)?.focus({ preventScroll: true });
    if (focusedAction) sessionsList.querySelector(`button[data-session-control="${CSS.escape(focusedAction)}"]`)?.focus({preventScroll:true});
    if (focusedTitle) sessionsList.querySelector(`button[data-metrics-for="${CSS.escape(focusedTitle)}"]`)?.focus({preventScroll:true});
  }

  renderSessions();

  // ---- manual ping ---------------------------------------------------------
  // One tiny prompt per model at the push of a button, to see which models are
  // alive and what each calls itself.
  const pingBox = document.createElement("div");
  pingBox.style.cssText = "border-top:" + BORDER + ";padding-top:10px;display:flex;flex-direction:column;gap:8px";

  const pingRow = document.createElement("div");
  pingRow.style.cssText = "display:flex;align-items:center;gap:8px";

  const [pingBusy, setPingBusy] = createSignal(false);
  insert(pingRow, createComponent(ui.Button, {
    variant: "neutral", size: "small", type: "button", onClick: ping,
    get busy() { return pingBusy(); },
    get disabled() { return pingBusy(); },
    get children() { return pingBusy() ? "Pinging…" : "Ping models"; },
  }));

  // One-click copy of the whole result as tab-separated rows, so it pastes into
  // a sheet or chat. The table itself is selectable too.
  const COPY_LABEL = "Copy for Discord";
  const [canCopy, setCopyState] = createSignal(false);
  const [copyLabel, setCopyLabel] = createSignal(COPY_LABEL);
  let copyTimer;
  const copyBtn = iconAction(copyLabel, {
    get icon() { return copyLabel() === "Copied" ? "check" : copyLabel() === "Copy failed" ? "warning" : "copy"; },
    get label() { return copyLabel(); }, get disabled() { return !canCopy(); },
    size: "small", variant: "ghost", onClick: copyResults,
  });
  pingRow.appendChild(copyBtn);

  const pingNote = document.createElement("span");
  pingNote.textContent = '"state your model and say pong"';
  pingNote.style.cssText = "opacity:.5;font-size:11px";
  pingRow.appendChild(pingNote);
  pingBox.appendChild(pingRow);

  const pingOut = document.createElement("div");
  pingOut.style.cssText = "overflow:auto;font-variant-numeric:tabular-nums";
  pingBox.appendChild(pingOut);
  root.appendChild(pingBox);

  let pingText = "";
  // A monospace table inside a code block: Discord keeps the padding, so the
  // columns line up when pasted as one message.
  function discordPingTable(results) {
    const rows = results.map((p) => [
      displayModel(p.model),
      p.ok ? "ok" : p.skipped ? "skipped" : "failed",
      p.ms ? secs(p.ms) : "-",
      String((p.ok ? p.text : p.error) || "").replace(/\s+/g, " ").trim(),
    ]);
    const head = ["Model", "Status", "Time", "Reply"];
    const widths = [0, 1, 2].map((i) => Math.max(head[i].length, ...rows.map((r) => r[i].length)));
    const line = (cells) => `${cells[0].padEnd(widths[0])}  ${cells[1].padEnd(widths[1])}  ${cells[2].padEnd(widths[2])}  ${cells[3]}`;
    const body = [head, ...rows].map(line).join("\n").replace(/```/g, "'''");
    return "```\n" + body + "\n```";
  }
  async function copyResults() {
    if (!pingText) return;
    // execCommand through a focused textarea first: it does not depend on the
    // clipboard permission the desktop shell may deny.
    let ok = false;
    const ta = document.createElement("textarea");
    ta.value = pingText;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    if (!ok && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(pingText); ok = true; } catch {}
    }
    setCopyLabel(ok ? "Copied" : "Copy failed");
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => setCopyLabel(COPY_LABEL), 1400);
  }

  async function ping() {
    if (pingBusy()) return;
    setPingBusy(true);
    pingOut.textContent = "";
    pingText = "";
    setCopyState(false);
    const waiting = document.createElement("div");
    waiting.textContent = "asking every model…";
    waiting.style.cssText = "opacity:.6";
    pingOut.appendChild(waiting);
    try {
      const r = await fetch(endpoint.replace(/\/usage\/?$/, "/ping"), { method: "POST", cache: "no-store" });
      const j = await r.json();
      pingOut.textContent = "";
      const results = j.results || [];
      if (!results.length) {
        const none = document.createElement("div");
        none.textContent = "no models answered";
        none.style.cssText = "opacity:.6";
        pingOut.appendChild(none);
      } else {
        const tbl = document.createElement("table");
        tbl.style.cssText = "width:100%;border-collapse:collapse;font-size:12px;user-select:text;-webkit-user-select:text;cursor:text";
        const head = document.createElement("tr");
        head.appendChild(th("Model", "left"));
        head.appendChild(th("Status", "left"));
        head.appendChild(th("Reply", "left"));
        head.appendChild(th("Time", "right"));
        tbl.appendChild(head);
        results.forEach((p, i) => {
          const last = i === results.length - 1;
          const tr = document.createElement("tr");
          tr.appendChild(td(displayModel(p.model), "left", { last, title: p.model, model: true }));
          const status = p.ok ? "ok" : p.skipped ? "skipped" : "failed";
          const st = td(status, "left", { last, muted: !p.ok, strong: p.ok });
          if (!p.ok) st.style.color = "rgb(190,110,90)";
          tr.appendChild(st);
          const reply = td(p.ok ? (p.text || "") : (p.error || ""), "left", {
            last, muted: !p.ok,
            title: p.ok ? "" : `${p.model}: ${p.error || ""}`,
          });
          reply.style.whiteSpace = "pre-wrap";
          reply.style.wordBreak = "break-word";
          reply.style.maxWidth = "340px";
          tr.appendChild(reply);
          tr.appendChild(td(p.ms ? secs(p.ms) : "-", "right", { last, muted: !p.ms }));
          tbl.appendChild(tr);
        });
        pingOut.appendChild(tbl);
        pingText = discordPingTable(results);
        setCopyState(true);
      }
      // pings are real requests, so refresh the numbers too
      refresh();
    } catch (e) {
      pingOut.textContent = "";
      pingText = "";
      setCopyState(false);
      const err = document.createElement("div");
      err.textContent = "ping failed: " + ((e && e.message) || "unreachable");
      err.style.cssText = "opacity:.6";
      pingOut.appendChild(err);
    } finally {
      setPingBusy(false);
    }
  }

  // ---- keys ---------------------------------------------------------------
  // The gateway meters each key separately, so a second key is a second set of
  // per-model windows. Stored next to the plugin, never in opencode.json.
  let keys = [];
  let pins = {};
  const keysUrl = endpoint.replace(/\/usage\/?$/, "/keys");
  const keyBox = document.createElement("div");
  keyBox.style.cssText = "border-top:" + BORDER + ";padding-top:10px;display:flex;flex-direction:column;gap:6px";

  const keyHead = document.createElement("button");
  // Collapsed by default: keys are masked, but there is no reason to keep them on
  // screen. Click the heading to open.
  const [keysOpen, setKeysOpen] = createSignal(false);
  keyHead.type = "button";
  keyHead.className = "prism-key-heading";
  insert(keyHead, createComponent(ui.Icon, { get name() { return keysOpen() ? "chevron-down" : "chevron-right"; }, size: "small" }));
  const keyCaption = document.createElement("span");
  keyHead.appendChild(keyCaption);
  keyBox.appendChild(keyHead);
  const keyBody = document.createElement("div");
  keyBody.id = "prism-keys-" + crypto.randomUUID();
  keyHead.setAttribute("aria-controls", keyBody.id);
  keyBox.appendChild(keyBody);

  const keyList = document.createElement("div");
  keyList.style.cssText = "display:flex;flex-direction:column;gap:3px";
  keyBody.appendChild(keyList);

  const keyNote = document.createElement("div");
  keyNote.style.cssText = "opacity:.5;font-size:11px";
  keyNote.textContent = "saved to keys.json - each session sticks to one key";
  keyBody.appendChild(keyNote);
  root.appendChild(keyBox);

  function paintKeysOpen() {
    keyCaption.textContent = "Keys" + (keys.length ? ` · ${keys.length}` : "");
    keyHead.setAttribute("aria-expanded", String(keysOpen()));
    keyBody.style.cssText = `display:${keysOpen() ? "grid" : "none"};gap:8px;padding:2px 4px`;
  }
  keyHead.onclick = () => { setKeysOpen(!keysOpen()); paintKeysOpen(); };
  paintKeysOpen();

  // Rows exist only for keys that are configured. Each row is one masked field
  // and four actions: Show reveals the value, Edit makes the field editable
  // (Save applies it), Pin glues the routed session to that key, × removes it.
  const keyCss = {
    field: [
      "width:100%", "box-sizing:border-box", "height:26px", "padding:0 8px", "border-radius:7px",
      "border:1px solid rgba(127,127,127,.35)", "background:transparent", "color:inherit",
      "font:inherit", "font-variant-numeric:tabular-nums",
    ].join(";"),
    button: [
      "height:26px", "padding:0 8px", "border-radius:7px", "border:1px solid rgba(127,127,127,.35)",
      "background:rgba(127,127,127,.08)", "color:inherit", "cursor:pointer", "font:inherit",
      "font-weight:600", "white-space:nowrap",
    ].join(";"),
  };
  const keyButton = (text, title, extra) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title || "";
    b.style.cssText = keyCss.button + ";" + (extra || "");
    return b;
  };
  const keyPlaceholder = () => {
    const s = document.createElement("span");
    s.style.visibility = "hidden";
    return s;
  };
  let keySig = "";

  function renderKeys() {
    paintKeysOpen();
    keyList.textContent = "";
    if (keys.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "no keys yet — OpenCode's own credential is used until you add one";
      empty.style.cssText = "opacity:.5;font-size:11px";
      keyList.appendChild(empty);
      return;
    }
    const rowStyle = "display:grid;grid-template-columns:minmax(0,1fr) 58px 58px 62px 26px;gap:6px;align-items:center";

    keys.forEach((current, idx) => {
      const i = idx + 1;
      const row = document.createElement("div");
      row.style.cssText = rowStyle;

      const input = document.createElement("input");
      input.type = "password";
      input.readOnly = true;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.value = KEY_MASK;
      input.title = current.hint;
      input.style.cssText = keyCss.field;

      let editing = false;
      const reveal = keyButton("Show", `Show key ${i}`);
      reveal.onclick = async () => {
        if (editing) return;
        if (input.type === "text") {
          input.type = "password";
          input.value = KEY_MASK;
          reveal.textContent = "Show";
          return;
        }
        try {
          const r = await fetch(`${keysUrl}/reveal?slot=${i}`, { cache: "no-store" });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
          input.type = "text";
          input.value = j.key;
          reveal.textContent = "Hide";
        } catch (e) {
          keyNote.textContent = "reveal failed: " + ((e && e.message) || "unreachable");
        }
      };

      const finishEdit = () => {
        editing = false;
        input.readOnly = true;
        input.type = "password";
        input.value = KEY_MASK;
        input.placeholder = "";
        edit.textContent = "Edit";
        reveal.style.opacity = "1";
        reveal.disabled = false;
      };
      const edit = keyButton("Edit", `Edit key ${i}`);
      edit.onclick = () => {
        if (!editing) {
          editing = true;
          input.readOnly = false;
          input.type = "password";
          input.value = "";
          input.placeholder = "new key";
          edit.textContent = "Save";
          reveal.style.opacity = ".45";
          reveal.disabled = true;
          input.focus();
          return;
        }
        const v = input.value.trim();
        if (!v) { finishEdit(); return; }
        saveKeys({ set: i, key: v });
      };
      input.onkeydown = (e) => {
        if (!editing) return;
        if (e.key === "Enter") { e.preventDefault(); edit.onclick(); }
        if (e.key === "Escape") { e.preventDefault(); finishEdit(); }
      };

      // Pin the routed session to this key: its requests then follow this key's
      // windows, which is how two sessions double the available capacity.
      const sid = sessionId();
      const isPinned = !!sid && Number(pins[sid]) === i;
      const pinCell = keyButton(isPinned ? "Pinned" : "Pin",
        sid ? `Use key ${i} for this session` : "Open a session first",
        isPinned ? "border:1px solid rgba(120,200,140,.65);background:rgba(120,200,140,.16)" : "");
      pinCell.disabled = !sid;
      pinCell.style.opacity = sid ? "1" : ".45";
      pinCell.style.cursor = sid ? "pointer" : "default";
      pinCell.onclick = () => {
        const id = sessionId();
        if (id) saveKeys({ pin: { session: id, key: i } });
      };

      const delCell = keyButton("×", `Remove key ${i}`, "padding:0");
      delCell.onclick = () => saveKeys({ remove: i });

      row.appendChild(input);
      row.appendChild(reveal);
      row.appendChild(edit);
      row.appendChild(pinCell);
      row.appendChild(delCell);
      keyList.appendChild(row);
    });
  }

  // Add row at the bottom: one field, one button.
  const addRow = document.createElement("div");
  addRow.style.cssText = "display:grid;grid-template-columns:minmax(0,1fr) 58px;gap:6px;align-items:center;margin-top:4px";
  const addInput = document.createElement("input");
  addInput.type = "password";
  addInput.autocomplete = "off";
  addInput.spellcheck = false;
  addInput.placeholder = "paste a key to add…";
  addInput.style.cssText = keyCss.field;
  const addBtn = keyButton("Add", "Add a key");
  const doAdd = () => {
    const v = addInput.value.trim();
    if (!v) return;
    addInput.value = "";
    saveKeys({ add: v });
  };
  addBtn.onclick = doAdd;
  addInput.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); doAdd(); }
  };
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  keyBody.appendChild(addRow);

  // Saves never touch the add field or the rows' edit state: they only update the
  // key list, pins, and the note.
  async function saveKeys(payload) {
    try {
      const r = await fetch(keysUrl, { method: "POST", cache: "no-store", body: JSON.stringify(payload) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      keys = j.keys || [];
      pins = j.pins || {};
      keySig = JSON.stringify([keys, pins, sessionId()]);
      renderKeys();
      keyNote.textContent = "saved to keys.json - each session sticks to one key";
    } catch (e) {
      keyNote.textContent = "key update failed: " + ((e && e.message) || "unreachable");
    }
  }

  renderKeys();

  let data = null;
  let error = null;
  // Live slot usage per model: used requests in the current window vs the cap.
  let slots = {};
  // model -> { count, from[] } for overflow traffic in flight (from /status).
  let overflowActive = {};

  function slotCell(el, name) {
    const s = slots[name];
    if (!s || !s.max) return el;
    const used = Math.min(s.used || 0, s.max);
    const width = Math.max(2, String(s.max).length);
    const pad = (n) => String(n).padStart(width, "0");

    const tag = document.createElement("span");
    tag.textContent = `[${pad(used)}/${pad(s.max)}] `;
    tag.style.cssText = used >= s.max
      ? "opacity:.95;font-weight:650;font-variant-numeric:tabular-nums"
      : "opacity:.5;font-variant-numeric:tabular-nums";
    tag.title = `${used} of ${s.max} requests in the window` +
      (s.tokenMax ? ` · ${fmt(s.tokensUsed || 0)} of ${fmt(s.tokenMax)} tokens (${(((s.tokensUsed || 0) / s.tokenMax) * 100).toFixed(1)}%)` : "");

    // `*` while this model is serving requests that overflowed from another one.
    const spill = overflowActive[name];
    const label = document.createElement("span");
    label.textContent = displayModel(name) + (spill ? ` *${spill.count}` : "");
    label.title = name; // the API id on hover
    if (spill) {
      label.title = `${spill.count} of the used slots in the last minute came from ${spill.from.join(", ")} overflowing here` +
        (spill.inFlight ? ` (${spill.inFlight} still running)` : "");
    }

    el.textContent = "";
    el.appendChild(tag);
    el.appendChild(label);
    return el;
  }

  function th(text, align, title) {
    const el = document.createElement("th");
    el.textContent = text;
    el.style.cssText = [
      "text-align:" + align,
      "padding:6px 8px",
      "border-bottom:1px solid rgba(127,127,127,.28)",
      "font-weight:600",
      "font-size:11px",
      "opacity:.6",
      "white-space:nowrap",
      title ? "cursor:help" : "",
    ].join(";");
    if (title) el.title = title;
    return el;
  }

  function td(text, align, opts = {}) {
    const el = document.createElement("td");
    el.textContent = text;
    el.style.cssText = [
      "text-align:" + align,
      "padding:6px 8px",
      "border-bottom:" + (opts.last ? "none" : BORDER),
      "white-space:nowrap",
      opts.strong ? "font-weight:650" : "",
      opts.muted ? "opacity:.6" : "",
      opts.model ? "max-width:190px;overflow:hidden;text-overflow:ellipsis" : "",
    ].join(";");
    if (opts.model) el.title = text;
    if (opts.title) el.title = opts.title;
    return el;
  }

  function paint() {
    for (const [k, b] of Object.entries(buttons)) {
      b.setAttribute("aria-pressed", String(k === win));
    }

    table.textContent = "";
    if (error || !data) { usedIds = null; showUnused(); }
    if (error) {
      for (const v of Object.values(cardValues)) v.textContent = "—";
      footer.textContent = "";
      const row = document.createElement("div");
      row.textContent = "proxy offline: " + error;
      row.style.cssText = "opacity:.7;padding:8px 0";
      table.appendChild(row);
      return;
    }
    if (!data) {
      cardValues.requests.textContent = "…";
      return;
    }

    renderKeyFilter();
    // "all keys" is the combined window; a key shows only what ran on that key.
    const selectedKey = keyView();
    const perKey = selectedKey !== "all" && data.perKey && data.perKey[win] && data.perKey[win][selectedKey];
    const w = selectedKey === "all"
      ? data.windows && data.windows[win]
      : (perKey ? perKey.total : { requests: 0, input: 0, output: 0, reasoning: 0, cached: 0, cost: 0 });
    if (!w) { usedIds = null; showUnused(); footer.textContent = "no data yet for " + win; return; }

    cardValues.requests.textContent = String(w.requests);
    const inputs = inputBreakdown(w);
    cardValues.input.textContent = fmt(inputs.uncached);
    cardValues.cached.textContent = fmt(inputs.cached);
    cardValues.input.parentElement.title = cardValues.cached.parentElement.title = inputs.title;
    cardValues.output.textContent = fmt(w.output);
    cardValues.cost.textContent = money(w.cost);

    const thead = document.createElement("thead");
    const hr = document.createElement("tr");
    for (const c of COLUMNS) hr.appendChild(th(c.label, c.align, c.title));
    thead.appendChild(hr);
    table.appendChild(thead);

    const body = document.createElement("tbody");
    const rowsSrc = selectedKey === "all" ? ((data.models && data.models[win]) || {}) : (perKey ? perKey.models : {});
    const rows = Object.entries(rowsSrc || {}).filter(([, m]) => m.requests > 0)
      .sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0) || (b[1].output || 0) - (a[1].output || 0));
    usedIds = new Set(rows.map(([id]) => id));
    showUnused();
    for (const [name, m] of rows) {
      const tr = document.createElement("tr");
      // Model cell tooltip: the API id plus the rates used for the cost column.
      const p = (data.pricing || {})[name];
      const priceTitle = p
        ? [name, `input $${p.in}/Mtok · output $${p.out}/Mtok · cached $${p.cached}/Mtok`,
           m.ttftMs || m.tpsN ? "" : null].filter(Boolean).join("\n")
        : name;
      tr.appendChild(slotCell(td(displayModel(name), "left", { model: true, title: priceTitle }), name));
      tr.appendChild(td(String(m.requests), "right"));
      const modelInput = inputBreakdown(m);
      tr.appendChild(td(fmt(modelInput.uncached), "right", { title: modelInput.title }));
      tr.appendChild(td(fmt(modelInput.cached), "right", { title: modelInput.title }));
      tr.appendChild(td(fmt(m.output), "right"));
      tr.appendChild(td(fmt(m.reasoning), "right"));
      tr.appendChild(td(m.avgTps ? String(m.avgTps) : "—", "right", { muted: !m.avgTps, title: tpsTitle(m) }));
      tr.appendChild(td(secs(m.ttftMs), "right", { muted: !m.ttftMs, title: ttftTitle(m) }));
      tr.appendChild(td(secs(m.avgMs), "right", { muted: !m.avgMs }));
      tr.appendChild(td(money(m.cost), "right"));
      body.appendChild(tr);
    }
    table.appendChild(body);

    // totals
    const tfoot = document.createElement("tfoot");
    const tr = document.createElement("tr");
    tr.style.background = "rgba(127,127,127,.06)";
    const sumReq = rows.reduce((n, [, m]) => n + (m.requests || 0), 0);
    tr.appendChild(td("Total", "left", { strong: true, last: true }));
    tr.appendChild(td(String(sumReq), "right", { strong: true, last: true }));
    tr.appendChild(td(fmt(inputs.uncached), "right", { strong: true, last: true, title: inputs.title }));
    tr.appendChild(td(fmt(inputs.cached), "right", { strong: true, last: true, title: inputs.title }));
    tr.appendChild(td(fmt(w.output), "right", { strong: true, last: true }));
    tr.appendChild(td(fmt(w.reasoning), "right", { strong: true, last: true }));
    tr.appendChild(td(w.avgTps ? String(w.avgTps) : "—", "right", { strong: true, last: true, title: tpsTitle(w) }));
    tr.appendChild(td(secs(w.ttftMs), "right", { strong: true, last: true, title: ttftTitle(w) }));
    tr.appendChild(td(secs(w.avgMs), "right", { strong: true, last: true }));
    tr.appendChild(td(money(w.cost), "right", { strong: true, last: true }));
    tfoot.appendChild(tr);
    if (rows.length > 1) table.appendChild(tfoot);

    footer.textContent =
      `auto ${Math.round(refreshMs / 1000)}s · updated ${new Date(data.updated || Date.now()).toLocaleTimeString()}` +
      (w.seeded ? ` · ${w.seeded} imported` : "") +
      (inputs.unknown ? ` · ${inputs.unknown.toLocaleString()} input tokens with unknown cache status` : "");
  }

  const born = Date.now();
  let inFlight = false;
  async function refresh() {
    if (!root.isConnected && Date.now() - born > 15000) { clearInterval(timer); return; }
    if (inFlight) return;
    if (Date.now() >= catalogDue) void syncCatalog();
    inFlight = true;
    setRefreshing(true);
    try {
      const [usageRes, statusRes, keysRes] = await Promise.all([
        fetch(endpoint, { cache: "no-store" }),
        fetch(endpoint.replace(/\/usage\/?$/, "/status"), { cache: "no-store" }).catch(() => null),
        fetch(keysUrl, { cache: "no-store" }).catch(() => null),
      ]);
      if (!usageRes.ok) throw new Error("HTTP " + usageRes.status);
      data = await usageRes.json();
      error = null;
      if (keysRes && keysRes.ok) {
        const kj = await keysRes.json();
        if (Array.isArray(kj.sessions)) {
          sessions = kj.sessions;
          renderSessions();
        }
        if (Array.isArray(kj.keys)) {
          keys = kj.keys;
          pins = kj.pins || {};
          // Re-render only when something the rows show has changed, so an open
          // Edit is not rebuilt by the 5-second poll.
          const sig = JSON.stringify([keys, pins, sessionId()]);
          if (sig !== keySig) {
            keySig = sig;
            renderKeys();
          }
        }
      }

      // Slot usage for the model column: live limiter state, plus the configured
      // caps so a model with no traffic yet still shows "0/6".
      slots = {};
      overflowActive = {};
      if (statusRes && statusRes.ok) {
        const s = await statusRes.json();
        overflowActive = (s.overflow && s.overflow.active) || {};
        for (const [name, v] of Object.entries(s.models || {})) {
          slots[name] = { used: v.used || 0, max: v.max || 0, tokensUsed: v.tokensUsed || 0, tokenMax: v.tokenMax || 0 };
        }
        // Models with no traffic yet have no live limiter: take both caps from the
        // configured limits so every row shows its request and token ceiling.
        const tokenCap = (name) => {
          const t = /^(\d+)\//.exec(String((s.tokenLimits || {})[name] || ""));
          return t ? Number(t[1]) : 0;
        };
        for (const [name, spec] of Object.entries(s.limits || {})) {
          const m = /^(\d+)\//.exec(String(spec));
          if (m && !slots[name]) slots[name] = { used: 0, max: Number(m[1]), tokensUsed: 0, tokenMax: tokenCap(name) };
        }
        for (const [name, v] of Object.entries(slots)) {
          if (!v.tokenMax) v.tokenMax = tokenCap(name);
        }
      }
    } catch (e) {
      error = (e && e.message) || "unreachable";
      slots = {};
    } finally {
      inFlight = false;
      setRefreshing(false);
    }
    paint();
  }

  const timer = setInterval(refresh, refreshMs);
  onCleanup(() => { clearInterval(timer); clearTimeout(copyTimer); catalogAbort.abort(); });
  paint();
  refresh();
  return root;
}

module.exports = {
  default: Plugin.define({
    i18n: { en: { title: "Prism usage", heading: "Usage" } },
    setup(ctx) {
      const endpoint = (ctx.options && ctx.options.usageEndpoint) || "http://127.0.0.1:17334/usage";
      const refreshMs = Math.max(1000, Number(ctx.options && ctx.options.refreshMs) || 5000);
      const key = `${ctx.id}:usage`;
      const statusUrl = endpoint.replace(/\/usage\/?$/, "/status");
      const owner = crypto.randomUUID();
      const control = (action,session) => ctx.client.rpc(schedulingRpc).control({action,session,owner});
      let lastFocus, renewed = 0;
      function publishFocus() {
        const id = document.hasFocus() && !document.hidden ? ctx.sessions?.current()?.id : null;
        if (!id && lastFocus) void control('unfocus',lastFocus).catch(()=>{});
        if (id && (id !== lastFocus || Date.now()-renewed >= 5000)) {
          renewed = Date.now(); void control('focus',id).catch(()=>{});
        }
        lastFocus = id;
      }
      window.addEventListener('blur',publishFocus);
      window.addEventListener('focus',publishFocus);

      // Proxy retry state for the pill: poll /status once a second.
      const statusTimer = setInterval(async () => {
        publishFocus();
        try {
          const r = await fetch(statusUrl, { cache: "no-store" });
          setProxyStatus(r.ok ? await r.json() : null);
        } catch {
          setProxyStatus(null);
        }
      }, 1000);

      const providers = Registry.define("prism-usage.working-providers");
      ctx.add(providers, {
        id: "prism",
        show: (input) => {
          const retry = proxyStatus()?.sessions?.[input.session.id];
          if (!retry) return undefined;
          return {
            label: `Retrying · HTTP ${retry.status}`,
            icon: "status",
            tone: "warning",
            title: `${retry.model || "Request"} · HTTP ${retry.status} · retry ${retry.retries}`,
          };
        },
      });

      const working = {
        show(input) {
          const session = input.session;
          const provider = session.server.data.session.get(session.id)?.model?.providerID;
          return ctx.list(providers).find((entry) => entry.id === provider)?.show(input);
        },
      };
      ctx.provide(Contract.define("prism-usage.working"), working);
      ctx.add(ComposerPill, { id: "working", order: 5, show: working.show });

      const tab = {
        id: "usage",
        get title() { return ctx.t("title"); },
        closable: "compact",
        fallback: true,
      };

      const open = () => {
        const session = ctx.sessions.current();
        if (session) ctx.layout.open(key, session);
      };

      ctx.add(Panel, {
        id: "usage",
        region: "side",
        width: "narrow",
        mobile: {
          get title() { return ctx.t("title"); },
          order: 40,
          kind: "menu",
          icon: "status",
          cached: true,
        },
        list: (input) => (input.open.includes("usage") ? [tab] : []),
        render: () => buildPanel(ctx.ui, endpoint, refreshMs, ctx.t("heading"), () => {
          const s = ctx.sessions && ctx.sessions.current ? ctx.sessions.current() : null;
          return s && s.id ? s.id : null;
        }, (id) => {
          // The title comes from the app's own session data, which knows every
          // session the server has, not just the one on screen.
          const s = ctx.sessions && ctx.sessions.current ? ctx.sessions.current() : null;
          const info = s && s.server && s.server.data && s.server.data.session && s.server.data.session.get(id);
          return info;
        }, () => ctx.client.rpc(catalogRpc).sync({}), control),
      });

      ctx.add(MenuItem, () => ({
        menu: "session.panel",
        id: "usage",
        title: ctx.t("title"),
        icon: "status",
        description: "tokens · cost · tps",
        run: open,
      }));

      ctx.add(Command, () => ({
        id: "usage",
        title: ctx.t("title"),
        section: "navigation",
        run: open,
      }));

      return () => {
        clearInterval(statusTimer);
        window.removeEventListener('blur',publishFocus); window.removeEventListener('focus',publishFocus);
        if(lastFocus) void control('unfocus',lastFocus).catch(()=>{});
      };
    },
  }),
};
