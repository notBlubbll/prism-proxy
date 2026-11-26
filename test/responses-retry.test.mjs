import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("Responses retries a gateway 502 before delivering a single stream", { timeout: 15000 }, async (t) => {
  const requests = [];
  const stream = 'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":1}}}\n\n';
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, body: Buffer.concat(chunks).toString() });
    if (requests.length === 1) res.writeHead(502, { "content-type": "text/html" }).end("Bad Gateway");
    else if (requests.length === 2) res.writeHead(200, { "content-type": "text/event-stream" }).end(stream);
    else res.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid input"}');
  });
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

  const base = `http://127.0.0.1:${port}`;
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
