import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// Imports index.js in-process (not spawned), so a fake ctx.rpc.register can
// capture the RPC implementation the plugin registers in setup(). Env vars
// that index.js reads at module load time must be set before the import.
async function loadProxyModule(t, { upstream = "http://127.0.0.1:1/doway/v1" } = {}) {
  const freePort = createServer();
  freePort.listen(0, "127.0.0.1");
  await once(freePort, "listening");
  const { port } = freePort.address();
  await new Promise((resolve) => freePort.close(resolve));

  const dir = await mkdtemp(join(tmpdir(), "prism-rpc-"));
  const entry = join(dir, "proxy.mjs");
  await copyFile(new URL("../index.js", import.meta.url), entry);
  // index.js imports queue-policy.mjs, so the copy needs its siblings too.
  await copyFile(new URL("../queue-policy.mjs", import.meta.url), join(dir, "queue-policy.mjs"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  process.env.PRISM_PROXY_PORT = String(port);
  process.env.PRISM_PROXY_UPSTREAM = upstream;
  process.env.PRISM_PROXY_KEYS_FILE = join(dir, "keys.json");
  process.env.PRISM_PROXY_KEYS = "test-key";

  // The module starts a real listener in setup(); only one may run at a time
  // (startServer reuses globalThis.__prismProxyServer), so close the previous
  // test's before creating this one.
  const prev = globalThis.__prismProxyServer;
  if (prev) try { prev.__prismShutdown?.(); } catch {}

  const mod = await import(pathToFileURL(entry).href);

  let captured = null;
  const fakeCtx = { rpc: { register: (_def, impl) => { captured = impl; return { dispose() {} }; } } };
  await mod.default.setup(fakeCtx);
  assert.ok(captured, "setup() must register an RPC implementation on ctx.rpc");

  t.after(() => {
    const server = globalThis.__prismProxyServer;
    if (server) try { server.__prismShutdown?.(); } catch {}
  });
  return { mod, impl: captured };
}

test("usage RPC returns the same report GET /usage would", async (t) => {
  const { impl } = await loadProxyModule(t);
  const report = await impl.usage({});
  assert.ok(report.windows, "usage report has a windows field, as GET /usage does");
  assert.ok(report.models, "usage report has a models field, as GET /usage does");
});

test("status RPC returns the proxy's live status", async (t) => {
  const { impl } = await loadProxyModule(t);
  const status = await impl.status({});
  assert.equal(status.proxy, "prism-proxy");
  assert.equal(typeof status.uptimeMs, "number");
});

test("keysList RPC reports the configured key, masked", async (t) => {
  const { impl } = await loadProxyModule(t);
  const keys = await impl.keysList({});
  assert.equal(keys.keys.length, 1);
  assert.ok(keys.keys[0].hint.startsWith("…"), "the real key is never returned by keysList");
});

test("keysUpdate RPC adds a key the same way POST /keys does", async (t) => {
  const { impl } = await loadProxyModule(t);
  const before = await impl.keysList({});
  const after = await impl.keysUpdate({ add: "sk-ant-second-key" });
  assert.equal(after.keys.length, before.keys.length + 1);
});

test("keysUpdate RPC rejects an out-of-range pin the same way POST /keys does", async (t) => {
  const { impl } = await loadProxyModule(t);
  // The implementation throws either an OpenCode declared error (patched with
  // { status, error }) or a plain Error (the fake context has no error helper).
  let caught = null;
  try {
    await impl.keysUpdate({ pin: { session: "ses_x", key: 99 } }, {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "an out-of-range pin must be rejected, not accepted");
  const message = caught?.modern?.data?.error || caught?.data?.error || caught?.message || "";
  assert.match(message, /no key 99/);
});

test("ping RPC runs the same ping flow as POST /ping", async (t) => {
  const { impl } = await loadProxyModule(t);
  const result = await impl.ping({ models: ["gpt-6.2-sol"] });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].model, "gpt-6.2-sol");
  assert.equal(result.results[0].ok, false); // nothing listens on 127.0.0.1:1
});

test("there is no keysReveal RPC method", async (t) => {
  const { impl } = await loadProxyModule(t);
  assert.equal(impl.keysReveal, undefined, "key reveal must stay HTTP-only and loopback-restricted");
});
