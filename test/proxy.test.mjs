import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function startProxy(t, handler) {
  const upstream = createServer(handler);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => upstream.close());

  const freePort = createServer();
  freePort.listen(0, "127.0.0.1");
  await once(freePort, "listening");
  const { port } = freePort.address();
  await new Promise(resolve => freePort.close(resolve));
  const dir = await mkdtemp(join(tmpdir(), "prism-retry-"));
  const entry = join(dir, "proxy.mjs");
  await copyFile(new URL("../index.js", import.meta.url), entry);
  const proxy = spawn(process.execPath, [entry], {
    cwd: dir,
    env: { ...process.env, PRISM_PROXY_KEYS: "test", PRISM_PROXY_KEYS_FILE: join(dir, "keys.json"), PRISM_PROXY_PORT: String(port), PRISM_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/doway/v1` },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const stopped = once(proxy, "exit");
  t.after(async () => { proxy.kill(); await stopped; await rm(dir, { recursive: true, force: true }); });
  await Promise.race([
    new Promise(resolve => proxy.stdout.on("data", bytes => { if (bytes.toString().includes("listening (standalone)")) resolve(); })),
    stopped.then(() => { throw new Error("Proxy exited before listening"); }),
  ]);

  return `http://127.0.0.1:${port}`;
}

test("Responses retries a gateway 502 before delivering a single stream", { timeout: 15000 }, async (t) => {
  const requests = [];
  const stream = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":1}}}\n\n';
  const base = await startProxy(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: Buffer.concat(chunks).toString() });
    if (requests.length === 1) res.writeHead(502, { "content-type": "text/html" }).end("Bad Gateway");
    else if (requests.length === 2) res.writeHead(200, { "content-type": "text/event-stream" }).end(stream);
    else res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid input"}');
  });
  const body = JSON.stringify({ model: "gpt-6.2-astra", input: "ping", stream: true });
  const post = () => fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const reply = await post();
  assert.equal(reply.status, 200);
  assert.equal(await reply.text(), stream);
  assert.deepEqual(requests, Array(2).fill({ url: "/doway/v1/responses", body }));
  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(status.global["global|1"].total, 2);
  assert.equal(status.retries5xx, 1);
  const rejected = await post();
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "invalid input" });
  assert.equal(requests.length, 3);
});

test("Root aliases use their native APIs, the pooled key, and the shared usage window", { timeout: 15000 }, async (t) => {
  const routes = {
    messages: ["claude-opus-4-5", "claude-sonnet-4-6", "claude-sonnet-5"],
    "chat/completions": ["Kimi-K2.6", "Kimi-K2.7-Code", "deepseek-v4-pro", "deepseek-v4-flash", "grok-4.7"],
    "images/generations": ["gpt-image-2"],
  };
  const ids = Object.values(routes).flat();
  const config = JSON.parse(await readFile(new URL("../opencode.prism.json", import.meta.url), "utf8")).providers.prism;
  const seen = [];
  const base = await startProxy(t, async (req, res) => {
    if (req.method === "GET") {
      const list = req.url === "/doway/v1/models" ? ["gpt-6.2-astra", "gpt-image-2"] : ids;
      return res.end(JSON.stringify({ object: "list", data: list.map(id => ({ id })) }));
    }
    const bytes = [];
    for await (const b of req) bytes.push(b);
    const body = Buffer.concat(bytes);
    const edit = req.url === "/v1/images/edits";
    const model = edit ? (await new Response(body, { headers: req.headers }).formData()).get("model") : JSON.parse(body).model;
    seen.push({ model, url: req.url, auth: req.headers.authorization, apiKey: req.headers["x-api-key"] });
    if (req.url === "/v1/messages") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":4,"output_tokens":0}}}\n\n');
      res.write(`data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "x".repeat(10000) } })}\n\n`);
      return res.end('data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n');
    }
    const usage = model === "gpt-image-2" ? { input_tokens: 5, output_tokens: 1, input_tokens_details: { text_tokens: 3, image_tokens: 2 } } : { prompt_tokens: 5, completion_tokens: 1 };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ usage }));
  });
  const list = await (await fetch(`${base}/v1/models`)).json();
  assert.deepEqual(list.data.map(x => x.id).sort(), ["gpt-6.2-astra", ...ids].sort());
  for (const [route, models] of Object.entries(routes)) {
    for (const model of models) {
      const m = config.models[model];
      assert.ok(m);
      const headers = { "content-type": "application/json" };
      if (route === "messages") headers["x-api-key"] = "client-placeholder";
      const r = await fetch(`${base}/v1/${route}`, { method: "POST", headers, body: JSON.stringify({ model }) });
      await r.arrayBuffer();
      assert.equal(r.status, 200);
      assert.deepEqual(seen.at(-1), { model, url: `/v1/${route}`, auth: "Bearer test", apiKey: route === "messages" ? "test" : undefined });
    }
  }
  const form = new FormData();
  form.set("image", new Blob([Uint8Array.of(0, 255, 42)], { type: "image/png" }), "test.png");
  form.set("model", "gpt-image-2");
  const edit = await fetch(`${base}/v1/images/edits`, { method: "POST", body: form });
  await edit.arrayBuffer();
  assert.equal(edit.status, 200);
  assert.equal(seen.at(-1).model, "gpt-image-2");
  const usage = (await (await fetch(`${base}/usage`)).json()).models["24h"];
  assert.equal(usage["claude-sonnet-5"].input, 34);
  assert.equal(usage["claude-sonnet-5"].cost, (10*2 + 20*0.2 + 4*2.5 + 2*10)/1e6);
  assert.equal(usage["gpt-image-2"].requests, 2);
  assert.equal(usage["gpt-image-2"].cost, 2*(3*5 + 2*8 + 1*30)/1e6);
  assert.equal((await (await fetch(`${base}/status`)).json()).global["global|1"].total, seen.length);
});

test("A Responses token 429 pauses the key across models and retries the unchanged body", { timeout: 15000 }, async (t) => {
  const calls = [];
  const statusPath = "/status";
  const body = JSON.stringify({ model: "gpt-6.2-astra", input: "ping", max_output_tokens: 128000 });
  const base = await startProxy(t, async (req, res) => {
    const request = await new Response(req).text();
    calls.push({ request, at: Date.now() });
    if (calls.length === 1) {
      res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({
        error: { message: "Token limit exceeded: 10000000 tokens per minute for this API key. Retry in 1s." },
      }));
    } else {
      res.writeHead(200, { "content-type": "application/json" }).end('{"usage":{"input_tokens":8,"output_tokens":1}}');
    }
  });
  const post = (body, session) => fetch(`${base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-session-id": session }, body,
  });
  const retry = post(body, "ses_astra");
  let cooldown;
  for (let i = 0; i < 40; i++) {
    cooldown = await (await fetch(base + statusPath)).json();
    if (cooldown.sessions.ses_astra?.status === 429) break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(cooldown.sessions.ses_astra?.status, 429);
  assert.ok(cooldown.global["global|1"].blockedMs > 0 && cooldown.global["global|1"].blockedMs <= 1000);
  const other = JSON.stringify({ model: "gpt-6.2-sol", input: "ping", max_output_tokens: 64 });
  const results = await Promise.all([retry, post(other, "ses_sol")]);
  for (const response of results) {
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.deepEqual(calls.map(call => call.request).sort(), [body, body, other].sort());
  assert.ok(calls.slice(1).every(call => call.at - calls[0].at >= 990));
  const status = await (await fetch(base + statusPath)).json();
  assert.equal(status.retries429, 1);
  assert.equal(status.global["global|1"].total, calls.length);
  assert.ok(status.global["global|1"].tokensUsed >= 128000 && status.global["global|1"].tokensUsed < 256000);
  assert.equal(status.sessions.ses_astra, undefined);
});
