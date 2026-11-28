import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function startProxy(t, handler, limits = {}, clock) {
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
  await copyFile(new URL("../queue-policy.mjs", import.meta.url), join(dir, "queue-policy.mjs"));
  await mkdir(join(dir, "server"), { recursive: true });
  await copyFile(new URL("../server/usage.js", import.meta.url), join(dir, "server", "usage.js"));
  const args = [];
  if (clock) {
    const preload = join(dir,'clock.mjs');
    await writeFile(preload, `const epoch=Date.now();let ms=0;Date.now=()=>epoch+ms;process.on('message',value=>{ms=value;process.send(ms)});`);
    args.push('--import', pathToFileURL(preload).href);
  }
  const proxy = spawn(process.execPath, [...args,entry], {
    cwd: dir,
    env: { ...process.env, ...limits, PRISM_PROXY_KEYS: "test", PRISM_PROXY_KEYS_FILE: join(dir, "keys.json"), PRISM_PROXY_PORT: String(port), PRISM_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/doway/v1` },
    stdio: clock ? ["ignore", "pipe", "inherit", "ipc"] : ["ignore", "pipe", "inherit"],
  });
  const stopped = once(proxy, "exit");
  if(clock) clock.set = async ms => { const ack=once(proxy,'message');proxy.send(ms);assert.equal((await ack)[0],ms); };
  t.after(async () => { proxy.kill(); await stopped; await rm(dir, { recursive: true, force: true }); });
  await Promise.race([
    new Promise(resolve => proxy.stdout.on("data", bytes => { if (bytes.toString().includes("listening (standalone)")) resolve(); })),
    stopped.then(() => { throw new Error("Proxy exited before listening"); }),
  ]);

  return `http://127.0.0.1:${port}`;
}

for (const dimension of ["requests", "tokens"]) {
  test(`Paces queued requests near the per-key ${dimension} limit before exhausting it`, async (t) => {
    const times = [];
    const body = JSON.stringify({ model: "gpt-6.2-astra", input: "ping" });
    const estimate = Math.ceil(body.length / 4);
    const base = await startProxy(t, (req, res) => {
      times.push(Date.now());
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end('{"usage":{"input_tokens":1,"output_tokens":1}}');
    }, {
      PRISM_PROXY_PACE_START_PERCENT: "50",
      PRISM_PROXY_GLOBAL_LIMITS: dimension === "requests" ? "global=4/1600ms" : "off",
      PRISM_PROXY_GLOBAL_TOKEN_LIMITS: dimension === "tokens" ? `global=${4 * estimate}/1600ms` : "off",
    });
    const post = () => fetch(`${base}/v1/responses`, { method: "POST", body }).then(r => r.json());
    const pending = Promise.all([post(), post(), post(), post()]);
    let wait;
    for (let i = 0; i < 30 && !wait; i++) {
      const status = await (await fetch(`${base}/status`)).json();
      assert.equal(status.globalLimits.paceStartPercent, 50);
      wait = status.global['global|1']?.wait;
      if (!wait) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(wait?.reason, dimension === 'requests' ? 'rpm-pacing' : 'tpm-pacing');
    assert.ok(wait.remainingMs > 0 && wait.remainingMs <= 400);
    await pending;
    assert.equal((await (await fetch(`${base}/status`)).json()).global['global|1'].wait, null);
    assert.equal(times.length, 4);
    assert.ok(times[1] - times[0] < 300, "no pacing through threshold");
    for (const i of [2, 3]) assert.ok(times[i] - times[i-1] >= 350, "separate consecutive near-cap sends");
  });
}

for (const dimension of ["requests", "tokens"]) {
  test(`Resumes pacing early when old ${dimension} leave the rolling window`, async (t) => {
    const body = JSON.stringify({ model: "gpt-6.2-astra", input: "ping" });
    const estimate = Math.ceil(body.length / 4);
    const base = await startProxy(t, (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" }).end('{"usage":{"input_tokens":1,"output_tokens":1}}');
    }, {
      PRISM_PROXY_PACE_START_PERCENT: "80",
      PRISM_PROXY_GLOBAL_LIMITS: dimension === "requests" ? "global=3/3000ms" : "off",
      PRISM_PROXY_GLOBAL_TOKEN_LIMITS: dimension === "tokens" ? `global=${3 * estimate}/3000ms` : "off",
    });
    const post = () => fetch(`${base}/v1/responses`, { method: "POST", body }).then(r => r.json());
    await post();
    await new Promise(resolve => setTimeout(resolve, 2500));
    await post();
    const start = Date.now();
    const pending = post();
    let wait;
    for (let i = 0; i < 20 && !wait; i++) {
      wait = (await (await fetch(`${base}/status`)).json()).global['global|1'].wait;
      if (!wait) await new Promise(resolve => setTimeout(resolve, 10));
    }
    await pending;
    assert.equal(wait?.releaseAmount, dimension === "requests" ? 1 : estimate);
    assert.ok(wait.remainingMs <= 550);
    assert.ok(Date.now() - start < 850, 'should not wait the full one-second gap');
  });
}

test("A short session follow-up budgets twice its measured context plus shared headroom", async (t) => {
  const base = await startProxy(t, (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" }).end('{"usage":{"input_tokens":350,"output_tokens":0}}');
  }, { PRISM_PROXY_GLOBAL_LIMITS: "off", PRISM_PROXY_GLOBAL_TOKEN_LIMITS: "global=1000/1000ms", PRISM_PROXY_PACE_START_PERCENT: "100" });
  const post = () => fetch(`${base}/v1/responses`, { method: "POST", headers: { "x-opencode-session-id":"ses_context" }, body:JSON.stringify({model:"gpt-6.2-astra",input:"ok"}) }).then(r => r.json());
  await post();
  const pending = post();
  let wait;
  for (let i=0; i<20 && !wait; i++) {
    wait = (await (await fetch(`${base}/status`)).json()).global['global|1'].wait;
    if (!wait) await new Promise(resolve=>setTimeout(resolve,10));
  }
  await pending;
  assert.equal(wait?.reason, "session-budget");
  assert.equal((await (await fetch(`${base}/status`)).json()).global['global|1'].tokensUsed,350);
});

test("Waits for the queued sessions as a group before admitting the first", async (t) => {
  const calls = [];
  const base = await startProxy(t, (req, res) => {
    req.resume();
    calls.push(Date.now());
    const input = [270, 450][calls.length - 1] ?? 1;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ usage: { input_tokens: input, output_tokens: 0 } }));
  }, { PRISM_PROXY_GLOBAL_LIMITS: "off", PRISM_PROXY_GLOBAL_TOKEN_LIMITS: "global=1000/1600ms", PRISM_PROXY_PACE_START_PERCENT: "100" });
  const post = (id, size) => fetch(`${base}/v1/responses`, {
    method: "POST", headers: { "x-opencode-session-id": id },
    body: JSON.stringify({ model: "gpt-6.2-astra", input: "x".repeat(size) }),
  }).then(r => r.json());
  await post('seed-1', 1);
  await new Promise(resolve => setTimeout(resolve, 650));
  await post('seed-2', 1);
  await Promise.all([post('session-a', 360), post('session-b', 360)]);
  assert.ok(calls[2] - calls[1] >= 1500, 'both contexts plus headroom must fit');
  assert.ok(calls[3] - calls[2] < 350, 'admitted group fits without another window reset');
  // A forecast larger than the usable window must eventually proceed alone.
  await post('oversized-session', 3000);
  assert.ok(calls[4] - calls[3] >= 1500);
});

test("Small sessions can pass a blocked session, but not indefinitely or out of session order", {timeout:10000}, async t => {
  const order = [];
  const base = await startProxy(t, async (req,res) => {
    const body = await new Response(req).json();
    order.push(body.tag);
    res.writeHead(200, {"content-type":"application/json"}).end(JSON.stringify({usage:{input_tokens:body.tag === 'seed' ? 400 : 1,output_tokens:1}}));
  }, {PRISM_PROXY_GLOBAL_LIMITS:'off', PRISM_PROXY_GLOBAL_TOKEN_LIMITS:'global=1000/1400ms', PRISM_PROXY_PACE_START_PERCENT:'100'});
  const post=(id,tag,size=1)=>fetch(`${base}/v1/responses`,{method:'POST',headers:{'x-opencode-session-id':id},body:JSON.stringify({model:'gpt-6.2-astra',tag,input:'x'.repeat(size)})}).then(r=>r.json());
  await post('seed','seed');
  const large=post('large','large',1200);
  for(let i=0;i<40;i++) {
    if((await (await fetch(`${base}/status`)).json()).global['global|1'].wait) break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  const sibling=post('large','sibling');
  for(let i=0;i<3;i++) await post('small'+i,'small'+i);
  assert.deepEqual(order,['seed','small0','small1','small2']);
  await Promise.all([large,sibling,post('last','last')]);
  assert.deepEqual(order.slice(4), ['last','large','sibling'], 'a fourth harmless bypass is allowed, and the sibling stays behind its own session');
});

const schedule = (base,action,session) => fetch(`${base}/admin/scheduling`,{method:'POST',headers:{'x-prism-admin':'1'},body:JSON.stringify({action,session})}).then(r=>r.json());
const turn = (base,session,extra={}) => fetch(`${base}/v1/responses`,{method:'POST',signal:AbortSignal.timeout(8000),headers:{'x-opencode-session-id':session,...extra},body:JSON.stringify({model:'gpt-6.2-astra',input:'hi'})}).then(r=>r.json());

test('Operating target spaces at 25/min, spends two small-only credits and never sends a 28th', async t => {
  const clock={}, calls=[];
  const base=await startProxy(t,(req,res)=>{
    calls.push(req.headers['x-opencode-session-id']); req.resume();
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({usage:{input_tokens:calls.length===1?700000:10,output_tokens:1}}));
  },{},clock);
  await turn(base,'large');
  for(let i=1;i<20;i++) await turn(base,'small');
  for(let i=1;i<=5;i++){await clock.set(i*2400);await turn(base,'small');}
  await clock.set(14400);
  const big=turn(base,'large');
  await turn(base,'small');
  await clock.set(16800);await turn(base,'small');
  await clock.set(19200);
  const extra=turn(base,'other');
  const status=await (await fetch(`${base}/status`)).json();
  assert.equal(status.global['global|1'].used,27);
  assert.equal(calls.length,27);
  await clock.set(60500);await schedule(base,'focus','large');
  await Promise.all([big,extra]);assert.equal(calls.length,29);
});

test('A family hold includes new descendants, leaves other sessions runnable, and expires after quiet',async t=>{
  const clock={},calls=[];
  const base=await startProxy(t,(req,res)=>{
    calls.push(req.headers['x-opencode-session-id']);assert.equal(req.headers['x-prism-ancestors'],undefined);req.resume();res.end('{}');
  },{},clock);
  await turn(base,'parent'); await schedule(base,'pause','parent');
  const child=turn(base,'new-child',{'x-prism-ancestors':'parent'});
  const grand=turn(base,'grand',{'x-prism-ancestors':'new-child,parent'});
  await turn(base,'other');assert.deepEqual(calls,['parent','other']);
  const before=await (await fetch(`${base}/keys`)).json();
  assert.equal(before.sessions.find(s=>s.id==='new-child').heldBy,'parent');
  assert.equal(before.sessions.find(s=>s.id==='grand').sending,0);
  await clock.set(5001);await schedule(base,'focus','other');await Promise.all([child,grand]);
  await schedule(base,'pause','parent');const pending=turn(base,'parent');await schedule(base,'resume','parent');await pending;
  assert.equal(calls.length,5);
});

test('Focused and background turns are ordered by the proxy; pause has a hard expiry',async t=>{
  const clock={}, order=[];
  const base=await startProxy(t,(req,res)=>{order.push(req.headers['x-opencode-session-id']);req.resume();res.end('{}')},{},clock);
  await schedule(base,'pause','parent');
  const tasks=['background','small','viewed'].map(id=>turn(base,id,{'x-prism-ancestors':'parent','x-prism-priority':id==='background'?'background':'normal'}));
  for(let i=0;i<30;i++){
    const s=await(await fetch(`${base}/status`)).json();if(s.queued===3)break;
    await new Promise(r=>setTimeout(r,10));
  }
  await schedule(base,'focus','viewed');await schedule(base,'resume','parent');await Promise.all(tasks);
  assert.deepEqual(order,['viewed','small','background']);
  await schedule(base,'pause','viewed');const paused=turn(base,'viewed');await clock.set(60001);await schedule(base,'focus','viewed');await paused;assert.equal(order.length,4);
});

test("Recent HTTP errors survive successful retries", async t => {
  const statuses=[520,503,502,200];
  const base=await startProxy(t,(req,res)=>{req.resume();res.writeHead(statuses.shift(),{'content-type':'application/json'}).end('{}');});
  const reply=await fetch(`${base}/v1/responses`,{method:'POST',headers:{'x-opencode-session-id':'test-session'},body:JSON.stringify({model:'gpt-6.2-astra',input:'hi'})});
  assert.equal(reply.status,200);
  const {recentErrors}=await (await fetch(`${base}/status`)).json();
  assert.deepEqual(recentErrors.map(e=>e.status),[502,503,520]);
  assert.ok(recentErrors.every(e=>e.sessionID==='test-session' && e.at>0 && e.model==='gpt-6.2-astra'));
});

test("Responses waits past the former 502 retry limit and delivers a single stream", { timeout: 70000 }, async (t) => {
  const requests = [];
  const times = [];
  const failures = 7;
  const stream = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":1}}}\n\n';
  const base = await startProxy(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: Buffer.concat(chunks).toString() });
    times.push(Date.now());
    if (requests.length <= failures) res.writeHead(502, { "content-type": "text/html", "retry-after": requests.length === 1 ? "60" : "1" }).end("Bad Gateway");
    else if (requests.length === failures + 1) res.writeHead(200, { "content-type": "text/event-stream" }).end(stream);
    else res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid input"}');
  });
  const body = JSON.stringify({ model: "gpt-6.2-astra", input: "ping", stream: true });
  const post = () => fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body });
  const reply = await post();
  assert.equal(reply.status, 200);
  assert.equal(await reply.text(), stream);
  assert.deepEqual(requests, Array(failures + 1).fill({ url: "/doway/v1/responses", body }));
  for (const [i, delay] of [1000, 5000, 10000, 10000, 10000, 10000, 10000].entries()) {
    const elapsed = times[i + 1] - times[i];
    assert.ok(elapsed >= delay - 100 && elapsed < delay + 2000, `retry ${i + 1}: ${elapsed} ms`);
  }
  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(status.global["global|1"].total, failures + 1);
  assert.equal(status.retries5xx, failures);
  const rejected = await post();
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "invalid input" });
  assert.equal(requests.length, failures + 2);
});

test("Canceling a request awaiting gateway recovery clears its retry state", { timeout: 10000 }, async (t) => {
  let attempts = 0;
  const base = await startProxy(t, (req, res) => {
    req.resume();
    attempts++;
    res.writeHead(502, { "retry-after": "10" }).end("Bad Gateway");
  });
  const controller = new AbortController();
  const post = fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session-id": "ses_cancel" },
    body: JSON.stringify({ model: "gpt-6.2-astra", input: "hello", stream: true }),
    signal: controller.signal,
  });
  const aborted = assert.rejects(post, { name: "AbortError" });
  let status;
  for (let i = 0; i < 40; i++) {
    status = await (await fetch(`${base}/status`)).json();
    if (status.sessions.ses_cancel?.status === 502) break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(status.sessions.ses_cancel?.status, 502);
  controller.abort();
  await aborted;
  for (let i = 0; i < 40; i++) {
    status = await (await fetch(`${base}/status`)).json();
    if (status.active === 0) break;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.equal(status.active, 0);
  assert.equal(status.sessions.ses_cancel, undefined);
  assert.equal(attempts, 1);
});

test("Text requests survive an upstream reset before headers or before the first body chunk", { timeout: 15000 }, async (t) => {
  const attempts = [];
  const stream = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
  const base = await startProxy(t, async (req, res) => {
    attempts.push({ path: req.url, key: req.headers.authorization, body: await new Response(req).text() });
    if (attempts.length === 1) return req.socket.destroy();
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (attempts.length === 2) {
      res.flushHeaders();
      return setTimeout(() => req.socket.destroy(), 25);
    }
    res.end(stream);
  });
  const body = JSON.stringify({ model: "gpt-6.2-astra", input: "ping", stream: true });
  const reply = await fetch(`${base}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
  assert.equal(reply.status, 200);
  assert.equal(await reply.text(), stream);
  assert.deepEqual(attempts, Array(3).fill({ path: "/doway/v1/responses", key: "Bearer test", body }));
  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(status.global["global|1"].total, attempts.length);
  assert.equal(status.retries5xx, 2);
});

test("A reset after a streamed event does not replay the request", { timeout: 10000 }, async (t) => {
  let attempts = 0;
  let upstreamSocket;
  const event = 'event: response.output_text.delta\ndata: {"delta":"partial"}\n\n';
  const base = await startProxy(t, (req, res) => {
    attempts++;
    upstreamSocket = req.socket;
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(event);
  });
  const reply = await fetch(`${base}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-6.2-astra", input: "ping", stream: true }) });
  const reader = reply.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), event);
  upstreamSocket.destroy();
  await assert.rejects(reader.read());
  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(attempts, 1);
  assert.equal(status.retries5xx, 0);
});

test("Compaction waits out 502s and resets without delivering partial buffered replies", { timeout: 12000 }, async (t) => {
  const called = [];
  const base = await startProxy(t, async (req, res) => {
    const { model } = await new Response(req).json();
    called.push(model);
    if (called.length === 1 || called.length === 4) return res.writeHead(502).end("Bad Gateway");
    if (called.length === 2 || called.length === 5) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"choices":[');
      return setTimeout(() => req.socket.destroy(), 25);
    }
    if (called.length === 3) return res.writeHead(400).end('{"error":"Refused"}');
    res.writeHead(200, { "content-type": "application/json" }).end('{"choices":[{"finish_reason":"stop"}]}');
  });
  const body = { model: "gpt-6.2-astra", messages: [{ role: "user", content: "x".repeat(21000) }] };
  const result = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).choices[0].finish_reason, "stop");
  assert.deepEqual(called, [...Array(3).fill("gpt-6.2-astra"), ...Array(3).fill("gpt-6.2-sol")]);
  const status = await (await fetch(`${base}/status`)).json();
  assert.equal(status.global["global|1"].total, called.length);
});

test("An interrupted image generation is not resubmitted or exposed as a raw socket error", { timeout: 10000 }, async (t) => {
  let attempts = 0;
  const base = await startProxy(t, (req) => { attempts++; req.socket.destroy(); });
  const reply = await fetch(`${base}/v1/images/generations`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2", prompt: "test" }),
  });
  assert.equal(reply.status, 502);
  const { error } = await reply.json();
  assert.ok(error.message);
  assert.doesNotMatch(error.message, /ECONNRESET|EPIPE|socket hang up|prism-proxy upstream error/i);
  assert.equal(attempts, 1);
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

test("Bare-major Claude requests are rewritten to adaptive thinking before forwarding", { timeout: 15000 }, async (t) => {
  const seen = [];
  const base = await startProxy(t, async (req, res) => {
    const bytes = [];
    for await (const chunk of req) bytes.push(chunk);
    seen.push(JSON.parse(Buffer.concat(bytes)));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}\n\n');
    res.end('data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
  });
  const post = body => fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test" },
    body: JSON.stringify(body),
  });
  await (await post({ model: "claude-sonnet-5", max_tokens: 16, thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: "high" } })).arrayBuffer();
  assert.deepEqual(seen.at(-1).thinking, { type: "adaptive" });
  assert.deepEqual(seen.at(-1).output_config, { effort: "high" });
  await (await post({ model: "claude-opus-4-5", max_tokens: 16, thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: "high" } })).arrayBuffer();
  assert.deepEqual(seen.at(-1).thinking, { type: "enabled", budget_tokens: 1024 }, "a model without adaptive support keeps its shape");
  await (await post({ model: "claude-sonnet-5", max_tokens: 16, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "xhigh" } })).arrayBuffer();
  assert.deepEqual(seen.at(-1).thinking, { type: "adaptive", display: "summarized" }, "an adaptive request is left alone");
});

test("A rejected per-turn effort request is retried without output_config.effort", { timeout: 15000 }, async (t) => {
  const seen = [];
  const base = await startProxy(t, async (req, res) => {
    const bytes = [];
    for await (const chunk of req) bytes.push(chunk);
    const body = JSON.parse(Buffer.concat(bytes));
    seen.push(body);
    if (body.output_config?.effort) {
      return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "output_config.effort requires a model that supports per-turn effort; this model does not" },
      }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
  });
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "test" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  await response.arrayBuffer();
  assert.equal(response.status, 200);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].output_config, undefined);
  assert.deepEqual(seen[1].thinking, { type: "adaptive" });
});
