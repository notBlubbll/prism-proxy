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
        if (editor.get("prism", id)) continue; // Keep user settings, including disabled entries.
        const adapter = rootChat.get(id) || (/^gpt-[56](?:[.-]|$)/.test(id) ? RESPONSES : CHAT);
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
