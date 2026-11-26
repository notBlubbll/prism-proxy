# prism-proxy

An OpenCode V2 plugin and standalone daemon for the PrismRouter
(`claude.c00l.site`) Doway and root endpoints. It adds a **global 30 requests/minute** and
**10M tokens/minute** sliding window per key, so OpenCode's fan-out (subagents,
retries, parallel tool calls) queues instead of hitting the gateway's `429`.
It also owns the credentials through a small key pool.

The request body (including the model id) is forwarded byte-exact. The proxy
does not rewrite prompts or model names.

## Why

PrismRouter meters the whole key, not each model: `30 requests per minute` plus
a token budget. OpenCode fans out requests and surfaces the `429` as a failed
turn. The proxy estimates each request's size, reserves a slot in both windows,
waits for room, and forwards only when the budget allows it.

## Limits

| Window | Default | Env |
| --- | --- | --- |
| Requests | 30 / 60s per key | `PRISM_PROXY_GLOBAL_LIMITS` |
| Tokens | 10,000,000 / 60s per key | `PRISM_PROXY_GLOBAL_TOKEN_LIMITS` |

The windows are global across models. Per-model limits are available with
`PRISM_PROXY_LIMITS` and `PRISM_PROXY_TOKEN_LIMITS` (format `model=30/60s`).
Each attempt reserves the estimated input plus the requested output budget.
Reported usage can increase that reservation. If PrismRouter sends a key-wide
429, the proxy pauses new requests on that key for the advertised delay and
retries the rejected request. Rejected attempts count toward RPM but release
their token reservation.

## Install

```sh
git clone https://github.com/notBlubbll/prism-proxy.git
cd prism-proxy
cp keys.json.example keys.json   # then paste the key
node index.js                    # or: bun index.js
```

`keys.json` is git-ignored. Send bare, case-sensitive model IDs to
`http://127.0.0.1:17334/v1`. The proxy sends GPT chat models to `/doway/v1`
and the following IDs to `/v1` on the same PrismRouter host:

| Local endpoint | Root model IDs |
| --- | --- |
| `/v1/messages` | `claude-opus-4-5`, `claude-sonnet-4-6`, `claude-sonnet-5` |
| `/v1/chat/completions` | `deepseek-v4-flash`, `deepseek-v4-pro`, `Kimi-K2.6`, `Kimi-K2.7-Code`, `grok-4.7` |
| `/v1/images/generations`, `/v1/images/edits` | `gpt-image-2` |

`GET /v1/models` also includes these root IDs when the key's root catalog lists
them. The panel's default ping list remains Doway-only.

## OpenCode

Copy [`opencode.prism.json`](./opencode.prism.json) into your OpenCode config,
or merge its `providers.prism` block. It points at
`http://127.0.0.1:17334/v1` and includes 28 chat models and one image model.
Use `prism/gpt-image-2` for image generation; it is not a session chat model.

The provider's `apiKey` is `{env:PRISM_API_KEY}`. With a key in `keys.json` the
proxy replaces whatever the client sends, so the env var only needs to be
non-empty. Set it in the OpenCode server environment:

```powershell
[Environment]::SetEnvironmentVariable("PRISM_API_KEY", "unused-with-a-key-pool", "User")
```

Or put the real key there and leave `keys.json` empty.

The provider defaults to the Responses API for Doway; root models select their
own runtime. That matters for the GPT-6.x models: the chat
completions endpoint rejects function tools combined with reasoning
(`Function tools with reasoning_effort are not supported ...`), while the
Responses API accepts them. Responses-only models (`gpt-5*-codex`,
`gpt-5*-pro`) can be added to the `models` map as well.

If a text endpoint returns HTTP 502 before streaming starts, the proxy waits
and retries the same request while the client stays connected. Each attempt
uses a rate-limit slot. Canceling the request stops further retries. Other
transient gateway errors are retried up to five times. An ongoing stream is
never replayed.

## Keys

`keys.json` supports up to 8 keys. The pool exists so a second key is a second
set of windows, but one key is the normal setup:

```json
{
  "keys": ["sk-ant-..."],
  "pins": {},
  "seen": {}
}
```

One session is pinned to one key and keeps using it. New sessions take the key
with the fewest live sessions. Pins expire after 14 days. `PRISM_PROXY_KEYS`
adds keys from the environment; `PRISM_PROXY_KEYS_FILE` moves the file.

`GET /keys` shows masked keys, pins and live sessions. `POST /keys` accepts
`{"add":"..."}`, `{"set":1,"key":"..."}`, `{"remove":1}` and
`{"pin":{"session":"ses_...","key":1}}`. `GET /keys/reveal?slot=1` returns the
full key to a loopback client only.

## Billing

`/usage` reports requests, input/output/cached/reasoning tokens, estimated USD
cost, time-to-first-token and decode speed per model. Prices come from
[models.dev](https://models.dev) (the `opencode` table, falling back to
`openai`), including model-specific context tiers. Claude cache reads and writes
and GPT Image 2 image-input tokens use their own rates when reported. Override a model's flat rates with:

```sh
PRISM_PROXY_PRICING="gpt-6.2-sol=2/10/0.1"
```

Costs are list-price estimates, not what PrismRouter bills.

## Endpoints

- `GET /healthz` -> `prism-proxy OK`
- `GET /status` -> limits, queue, per-model counters, key slots, global window
- `GET /usage` -> 24u / 24h / 7d / 30d / all windows
- `GET /keys` -> masked pool and session pins
- `POST /keys` -> add, set, remove, pin
- `POST /admin/reload` with `x-prism-admin: 1` -> hot-reload `index.js`

## Env vars

| Var | Default | Meaning |
| --- | --- | --- |
| `PRISM_PROXY_PORT` | `17334` | listen port (127.0.0.1 only) |
| `PRISM_PROXY_UPSTREAM` | `https://claude.c00l.site/doway/v1` | upstream base URL |
| `PRISM_PROXY_KEYS` | - | comma list added to the pool |
| `PRISM_PROXY_KEYS_FILE` | `keys.json` | key/pin store |
| `PRISM_PROXY_GLOBAL_LIMITS` | `global=30/60s` | global request window |
| `PRISM_PROXY_GLOBAL_TOKEN_LIMITS` | `global=10000000/60s` | global token window |
| `PRISM_PROXY_LIMITS` | empty | per-model request windows |
| `PRISM_PROXY_TOKEN_LIMITS` | empty | per-model token windows |
| `PRISM_PROXY_PRICING` | models.dev table | `model=in/out/cached` USD per 1M |
| `PRISM_PROXY_RL_BUDGET_MS` | `600000` | 429 wait ceiling per request |
| `PRISM_PROXY_VISION` | on | `0` disables caption fallback |
| `PRISM_PROXY_VISION_TARGETS` | empty | text-only models to caption for |
| `PRISM_PROXY_VISION_MODEL` | `gpt-5.4-nano` | captioning model |
| `PRISM_PROXY_VISION_PROMPT` | built-in | caption prompt override |
| `PRISM_PROXY_COMPACTION` | on | `0` disables compaction protection |
| `PRISM_PROXY_COMPACTION_MODEL` | `gpt-6.2-sol` | handoff for blocked summaries |
| `PRISM_PROXY_COMPACTION_MIN_BYTES` | `20000` | prompt size that marks a tool-less request as compaction |
| `PRISM_PROXY_OVERFLOW` | none | `from=to:wait` spill rules |
| `PRISM_PROXY_IMAGE_SHRINK_MB` | `8` | body size where the oldest images are replaced |
| `PRISM_PROXY_MAX_IMAGES` | `6` | max image parts kept in a request |
| `PRISM_PROXY_PING_TIMEOUT_MS` | `30000` | hard limit for one ping |
| `PRISM_PROXY_PING_WAIT_MS` | `180000` | slot wait for a ping |

## Desktop sidebar panel

`desktop-usage-panel/` adds a **Prism usage** tab to the session side region:
summary cards, one row per model, a 24u / 24h / 7d / 30d / all switch, a refresh
button, and a working composer pill. It reads `/usage` and `/status` from the
proxy on `127.0.0.1:17334`. The key selector appears once there are two keys.
The panel renders one **Working** pill for the session's active provider. Other
usage panels can contribute `{ id: providerID, show(input) }` to the GUI registry
`prism-usage.working-providers` and omit their own pill while the
`prism-usage.working` contract is active.

Install it next to the proxy plugin:

```sh
cp -r desktop-usage-panel ~/.config/opencode/plugins/prism-usage
opencode reload
```

Open **Prism usage** from the session side panel's **+** menu. OpenCode Desktop
reloads the local GUI bundle when it changes. Options when the plugin is listed
in `opencode.jsonc`: `refreshMs` and `usageEndpoint`.

## Files

- `index.js` - proxy, limiter, key pool, usage accounting
- `desktop-usage-panel/` - optional OpenCode Desktop sidebar panel
- `opencode.prism.json` - OpenCode provider block
- `keys.json.example` - placeholder key file
- `keys.json` - real key, git-ignored
- `.prism-usage.json` / `.prism-usage.jsonl` - usage history, git-ignored
- `.prism-proxy.log` - log, git-ignored

## License

MIT
