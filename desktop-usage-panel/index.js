const CHAT = "@opencode/ai/providers/openai-compatible";
const RESPONSES = `${CHAT}/responses`;
const MESSAGES = "@opencode/ai/providers/anthropic-compatible";
// Root aliases appended by the proxy sometimes have no capabilities metadata.
const rootChat = new Map([
  ...["claude-opus-4-5", "claude-sonnet-4-6", "claude-sonnet-5"].map(id => [id, MESSAGES]),
  ...["deepseek-v4-flash", "deepseek-v4-pro", "Kimi-K2.6", "Kimi-K2.7-Code", "grok-4.7"].map(id => [id, CHAT]),
]);

function chatCatalog(entries) {
  if (!Array.isArray(entries)) throw new Error("Invalid Prism model catalog");
  const ids = new Set();
  for (const entry of entries) {
    const id = entry?.id;
    if (typeof id !== "string" || !/^[\w][\w.-]*$/.test(id) || entry.lifecycle_status === "deprecated") continue;
    if (entry.status && entry.status !== "succeeded") continue;
    if (entry.deprecation?.inference && entry.deprecation.inference <= Date.now() / 1000) continue;
    const chat = entry.capabilities?.chat_completion;
    if (chat === true || (chat == null && rootChat.has(id))) ids.add(id);
  }
  return [...ids].filter(id => {
    const alias = id.replace(/-\d{4}-\d{2}-\d{2}(?=-|$)/, "");
    return alias === id || !ids.has(alias);
  }).sort();
}

const catalogRpc = { id: "prism-usage.catalog", events: {}, methods: {
  sync: { input: { type: "object", additionalProperties: false }, output: { type: "array", items: { type: "string" } } },
} };

const schedulingRpc = { id: "prism-usage.scheduling", events: {}, methods: {
  control: { input: { type:"object", required:["action","session"], properties:{ action:{enum:["focus","unfocus","pause","resume"]}, session:{type:"string"}, owner:{type:"string"} }, additionalProperties:false }, output:{type:"boolean"} },
} };

// Confirmed live against the real upstream (2026-11-28): bare "-N" Claude IDs on
// this gateway (no minor-version digit, e.g. "claude-sonnet-5") reject the classic
// `thinking: {type:"enabled", budget_tokens}` request OpenCode sends by default for
// Claude 5.0 and below. They require `thinking: {type:"adaptive"}` instead, and the
// gateway rejects `output_config.effort` without it ("output_config.effort requires
// a model that supports per-turn effort; this model does not"). Every effort level
// the gateway accepts returned 200 with adaptive thinking: low, medium, high, xhigh
// and max. OpenCode's own detection for the effort-update/adaptive code path looks
// for "Claude Opus 5, Claude 5.1 and later" by parsing the ID's version digits, so a
// bare "-5" id with no minor version can fall on the wrong side of that check;
// compatibility.supportsEffortUpdates forces the correct path regardless of how
// that detection reads this exact id.
// "claude-sonnet-5" (bare major version) qualifies; "claude-opus-4-5" (major-minor
// pair, e.g. Opus "4.5") does not — only the latter has evidence of needing the
// classic style, and we have none that the bare-major form also does.
function isAdaptiveThinkingId(id) {
  return /-\d+$/.test(id) && !/-\d+-\d+$/.test(id);
}
const ADAPTIVE_THINKING_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// display defaults to "omitted" on these models, which returns thinking blocks with
// an empty `thinking` field (only the opaque `signature` is populated) even though
// reasoning tokens are spent and billed. "summarized" is required to get back
// readable thinking text. Models that already exist in the user's config keep their
// metadata, but they still need this shape: the transform used to skip them, which
// left them on the classic thinking.enabled path that the gateway rejects.
function applyAdaptiveThinking(model) {
  model.compatibility = { ...model.compatibility, supportsEffortUpdates: true };
  model.capabilities = { ...model.capabilities, reasoning: { supported: true, effort: ADAPTIVE_THINKING_EFFORTS } };
  model.settings = { ...model.settings, thinking: { type: "adaptive", display: "summarized" } };
  // capabilities.reasoning drives auto-built variants only for models with a backing
  // provider template; a model discovered and created purely through this plugin has
  // none, so the variants are declared explicitly here. Confirmed live: reasoningEffort
  // reaches output_config.effort for this protocol once compatibility.supportsEffortUpdates
  // is set above.
  model.variants = ADAPTIVE_THINKING_EFFORTS.map(effort => ({ id: effort, settings: { reasoningEffort: effort } }));
}

async function setupScheduling(ctx, endpoint) {
  await ctx.rpc.register(schedulingRpc, { async control(command) {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("Session scheduling requires a local proxy");
    const response = await fetch(new URL('/admin/scheduling', endpoint), {
      method:'POST', headers:{'x-prism-admin':'1','content-type':'application/json'}, body:JSON.stringify(command), redirect:'error', signal:AbortSignal.timeout(4000),
    });
    if (!response.ok) throw new Error(`Scheduling control returned HTTP ${response.status}`);
    return true;
  }});
  await ctx.command.transform(editor => editor.add({ name:'prism-background', description:'Send this question with background Prism priority',
    execute: async ({sessionID,prompt,delivery}) => { await ctx.session.prompt({...prompt, sessionID, delivery, metadata:{prismPriority:'background'}}); },
  }));
  await ctx.session.hook('prompt', async e => {
    if (e.metadata?.prismPriority === 'background') return;
    const result = await ctx.session.get({sessionID:e.sessionID});
    if ((result?.data ?? result)?.model?.providerID === 'prism') e.metadata = {...e.metadata, prismPriority:'normal'};
  });
  const turnPriority = new Map();
  const families = new Map();
  // A child can issue its first call after the parent has started another
  // turn. Match its creation time to the parent's actual background intervals.
  async function recordTurn(id, priority) {
    if (turnPriority.get(id) === priority) return;
    const key = `background-turns:${id}`;
    const periods = await ctx.storage.get(key) || [];
    const last = periods.at(-1);
    if (priority === 'background' && !last?.open) {
      periods.push({start:Date.now(),open:true});
      await ctx.storage.set(key, periods);
    } else if (priority !== 'background' && last?.open) {
      periods[periods.length - 1] = {start:last.start, end:Date.now()};
      await ctx.storage.set(key, periods);
    }
    turnPriority.set(id, priority);
  }
  async function family(sessionID) {
    if (families.has(sessionID)) return families.get(sessionID);
    const ancestors = [];
    let inherited = false;
    let id = sessionID;
    while (ancestors.length < 64) {
      const result = await ctx.session.get({sessionID:id});
      const info = result?.data ?? result;
      if (!info?.parentID || info.fork || info.parentID === sessionID || ancestors.includes(info.parentID)) break;
      id = info.parentID;
      ancestors.push(id);
      if (!inherited) {
        const periods = await ctx.storage.get(`background-turns:${id}`) || [];
        inherited = periods.some(p => p.start <= info.time.created && (p.open || info.time.created < p.end));
      }
    }
    const value = {ancestors,inherited};
    families.set(sessionID,value);
    return value;
  }
  await ctx.session.hook('context', async e => {
    const current = e.messages.findLast(m => m.role === 'user' && m.metadata?.prismPriority);
    const {inherited} = await family(e.sessionID);
    await recordTurn(e.sessionID,inherited || current?.metadata.prismPriority === 'background' ? 'background' : 'normal');
  }, {providerID:'prism'});
  await ctx.session.hook('http.request', async e => {
    if (new URL(e.request.url).origin !== endpoint.origin) return;
    const {ancestors,inherited} = await family(e.sessionID);
    const headers = e.request.headers;
    headers.set('x-opencode-session-id',e.sessionID);
    headers.set('x-prism-ancestors',ancestors.join(','));
    headers.set('x-prism-priority',inherited ? 'background' : turnPriority.get(e.sessionID) || 'normal');
  }, {providerID:'prism'});
}

export default {
  id: "prism-usage",
  async setup(ctx) {
    const endpoint = new URL("v1/models", new URL(".", ctx.options?.usageEndpoint || "http://127.0.0.1:17334/usage"));
    await setupScheduling(ctx,endpoint);
    const cacheKey = `chat-catalog-v1:${endpoint.href}`;
    const saved = await ctx.storage.get(cacheKey);
    let ids = Array.isArray(saved) ? saved : [];
    const stop = new AbortController();
    let inFlight;

    await ctx.model.transform(editor => {
      if (!editor.provider.get("prism")) return;
      for (const id of ids) {
        const adapter = rootChat.get(id) || (/^gpt-[56](?:[.-]|$)/.test(id) ? RESPONSES : CHAT);
        const adaptive = adapter === MESSAGES && isAdaptiveThinkingId(id);
        if (editor.get("prism", id)) {
          // Keep user settings, including disabled entries, but repair the adaptive
          // shape a bare-major Claude model needs to accept an effort field.
          if (adaptive) editor.update("prism", id, applyAdaptiveThinking);
          continue;
        }
        const template = editor.provider.get(adapter === MESSAGES ? "anthropic" : "openai")?.models.get(id);
        editor.update("prism", id, model => {
          model.package = adapter;
          model.name = template?.name || id;
          if (template) {
            model.limit = structuredClone(template.limit);
            model.cost = structuredClone(template.cost);
            model.capabilities = structuredClone(template.capabilities);
          }
          if (adapter === RESPONSES) model.settings = { ...model.settings, reasoningSummary: "detailed" };
          if (adaptive) applyAdaptiveThinking(model);
        });
      }
    });

    async function readCatalog() {
      const response = await fetch(endpoint, { cache: "no-store", redirect: "error", signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error(`Prism catalog returned HTTP ${response.status}`);
      const next = chatCatalog((await response.json()).data);
      if (JSON.stringify(next) !== JSON.stringify(ids)) {
        const old = ids;
        ids = next;
        try { await ctx.model.reload(); } catch (error) { ids = old; throw error; }
        await ctx.storage.set(cacheKey, next);
      }
      return ids;
    }
    function sync() {
      return inFlight ||= readCatalog().finally(() => { inFlight = undefined; });
    }
    await ctx.rpc.register(catalogRpc, { sync });
    void sync().catch(() => {});
    const timer = setInterval(() => void sync().catch(() => {}), 15 * 60000);
    return () => { stop.abort(); clearInterval(timer); };
  },
};
