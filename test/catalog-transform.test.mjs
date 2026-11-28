import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../desktop-usage-panel/index.js";

test("Existing bare-major Claude models are repaired to adaptive thinking with xhigh", async t => {
  const catalog = ["claude-sonnet-5", "gpt-6.2-astra"];
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: catalog.map(id => ({ id, capabilities: { chat_completion: true } })),
  }));
  const storage = new Map([["chat-catalog-v1:http://127.0.0.1:17334/v1/models", catalog]]);
  const models = {
    "claude-sonnet-5": {
      name: "Claude Sonnet 5",
      settings: { custom: true },
      capabilities: { reasoning: { supported: true, effort: ["low", "medium", "high"] } },
    },
    "gpt-6.2-astra": { name: "GPT-6.2 Astra" },
  };
  let transform;
  let reloads = 0;
  const ctx = {
    model: {
      transform: async callback => { transform = callback; },
      reload: async () => { reloads++; },
    },
    rpc: { register: async () => {} },
    command: { transform: async callback => callback({ add: () => {} }) },
    storage: {
      get: async key => structuredClone(storage.get(key)),
      set: async (key, value) => storage.set(key, structuredClone(value)),
    },
    session: { hook: async () => {} },
  };
  const dispose = await plugin.setup(ctx);
  t.after(dispose);
  assert.equal(reloads, 0, "an unchanged catalog must not trigger a reload");

  transform({
    provider: { get: id => (id === "prism" ? { models: new Map() } : undefined) },
    get: (_providerID, id) => models[id],
    update: (_providerID, id, callback) => callback(models[id] ??= {}),
  });

  const sonnet = models["claude-sonnet-5"];
  assert.equal(sonnet.settings.custom, true, "existing settings must be preserved");
  assert.deepEqual(sonnet.settings.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(sonnet.compatibility.supportsEffortUpdates, true);
  assert.deepEqual(sonnet.capabilities.reasoning.effort, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(sonnet.variants.map(variant => variant.id), ["low", "medium", "high", "xhigh", "max"]);

  assert.deepEqual(models["gpt-6.2-astra"], { name: "GPT-6.2 Astra" },
    "models without the bare-major Claude shape must stay untouched");
});
