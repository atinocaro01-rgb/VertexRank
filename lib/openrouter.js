// Shared helper for every AI call in VertexRank. Same public API as before
// (callOpenRouter, callOpenRouterJson, parseModelJson, extractJson) — every
// API route that imports this file needs no changes.
//
// What changed and why (see the two problems this fixes below):
//
//   1. SPEED: the previous version tried providers one at a time — fully
//      timing out or failing on one before even starting the next. With up
//      to 7 possible attempts (2 LLMsRelay + 5 OpenRouter free models) at a
//      15s timeout each, a bad run could chain multiple full timeouts back
//      to back and approach or exceed Vercel's 60s function ceiling,
//      producing a 504 the frontend reports as "took too long."
//      Fix: attempts within a stage now RACE concurrently (first usable
//      response wins), so total latency is close to the fastest provider,
//      not the sum of the slow/failing ones. Once a winner is found, the
//      other in-flight requests in that stage are aborted.
//
//   2. RELIABILITY: a single malformed/off-format reply from one endpoint
//      (e.g. a generic "Hi, I'm Claude..." instead of the requested JSON —
//      a known occasional quirk of third-party relays like LLMsRelay) used
//      to immediately fall through the ENTIRE remaining chain, including
//      the slow/free OpenRouter models, before the user saw a result.
//      Fix: if every attempt in the preferred (LLMsRelay) stage fails
//      SPECIFICALLY because of an invalid-JSON reply (not a timeout or
//      outage), we retry that same stage once more with a sharper
//      formatting reminder before falling back to OpenRouter. A pure
//      timeout/outage skips straight to fallback instead, since retrying a
//      down endpoint wastes time without helping.
//
// PROVIDER SWITCHES: see the PROVIDERS object below — only providers set to
// true are used. Token Harbor is currently the only one enabled.
//
// Priority order (when enabled):
//   -1. Manus agent API (trial)
//   0. Token Harbor free tier (DEFAULT) — OpenAI-compatible, $0, multi-key pool
//        claude-haiku-5.5:free -> deepseek-v4.1-flash:free -> mimo-v2.6-flash:free
//   1. LLMsRelay — native Anthropic Messages API (api.llmsrelay.com/v1/messages)
//   2. LLMsRelay — OpenAI-compatible endpoint    (api.llmsrelay.com/v1/chat/completions)
//   3. OpenRouter free-model chain (5 models, final fallback)
//
// TOKEN HARBOR (default provider): set TOKENHARBOR_API_KEYS to one or more
// keys separated by commas or new lines (TOKENHARBOR_API_KEY, singular, also
// works). Keys are rotated per request; a key that gets HTTP 429 (rate limit)
// or 401/403 (bad key) is skipped for a cooldown period so one exhausted
// account never slows down the others. Within a key the three free models
// are *hedged*: Haiku starts immediately, DeepSeek only starts if Haiku
// hasn't answered after ~3s, MiMo after ~6s — fast when healthy, but it does
// not triple your free allowance on every call. Override the model list with
// TOKENHARBOR_MODELS (comma-separated model ids). The Haiku 5.5 free listing
// is marked "limited time", which is why the later providers stay as backup.
//
// Model IDs verified against LLMsRelay's live docs (llmsrelay.com/docs) as of
// September 2026: their catalogue is claude-opus-5, claude-fable-5,
// claude-opus-4.8/4.7/4.6, claude-sonnet-5, claude-sonnet-4.6, claude-haiku-4.5
// — NOT the Anthropic API's own dated model strings, and NOT OpenAI model IDs
// on the "OpenAI-compatible" route (that route still serves Claude models,
// just via chat-completions shape).
//
// LLMsRelay is an independently operated third-party API gateway/reseller,
// not an official Anthropic product — worth knowing since if the underlying
// account it resells access from is ever suspended, this provider could stop
// working without notice. That's exactly why it's wired as a *prioritized
// attempt*, not the only option: OpenRouter's free chain remains a working
// fallback if LLMSRELAY_API_KEY is unset or every LLMsRelay attempt fails.
//
// If LLMSRELAY_API_KEY isn't set, LLMsRelay is skipped entirely and
// OpenRouter is used as before — no env vars are required to change for
// existing deployments to keep working.
//
// OPENROUTER KEY POOL: OPENROUTER_API_KEYS (comma-separated) lets the
// fallback stage round-robin across several free-tier OpenRouter accounts
// instead of just one. Each key still only gets used as a last resort
// after LLMsRelay; this only widens that last resort. If a key's whole
// model chain fails (e.g. HTTP 429 — that key's free-tier rate limit hit),
// the next key in the pool is tried, up to the overall time budget.
// OPENROUTER_API_KEY (singular) still works unchanged if you only have one.

// ===========================================================================
// PROVIDER SWITCHES — flip a value to true/false to turn a provider on or off.
// Disabled providers are skipped entirely (their code and their Vercel env
// vars stay exactly as they are), so re-enabling one later is a one-word
// change here. Currently: Token Harbor only (Manus trial finished).
// ===========================================================================
const PROVIDERS = {
  manus: false,
  tokenharbor: true,
  llmsrelay: false,
  openrouter: false,
};

// ---------------------------------------------------------------------------
// MANUS (trial). Manus is an asynchronous *agent* API, not a chat-completions
// API: we create a task, poll its messages until the agent stops, then read
// the final assistant message. Docs: open.manus.ai/docs/v2/task-lifecycle
//   - Auth header:  x-manus-api-key
//   - Input limit:  ~5,000 tokens of text per task (we trim above MANUS_MAX_INPUT_CHARS)
//   - Free accounts are always run on the "lite" profile; every task spends credits.
// Env: MANUS_API_KEY (or MANUS_API_KEYS, comma/newline separated, rotated per request).
// Optional: MANUS_AGENT_PROFILE (default "lite"), MANUS_TIMEOUT_MS (default 50000).
// ---------------------------------------------------------------------------
const MANUS_BASE = process.env.MANUS_BASE_URL || "https://api.manus.ai";
const MANUS_AGENT_PROFILE = process.env.MANUS_AGENT_PROFILE || "lite";
const MANUS_TIMEOUT_MS = Number(process.env.MANUS_TIMEOUT_MS) || 50000;
const MANUS_POLL_MS = 1500;
const MANUS_MAX_INPUT_CHARS = 17000; // ≈4,250 tokens, under Manus's ~5,000-token cap
const MANUS_DELETE_TASKS = false; // trial: leave tasks in your Manus account so you can inspect them
const MANUS_HIDE_TASKS = false;

const MANUS_PREAMBLE = `You are being called by an application's backend, not chatting with a person. Answer directly in a single reply using only the information below. Do not browse the web, run tools, ask questions, or create files. Output exactly what is requested and nothing else.

`;

let manusKeyCursor = 0;

function getManusKeyPool() {
  const keys = (process.env.MANUS_API_KEYS || "").split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
  if (!keys.length && process.env.MANUS_API_KEY) keys.push(process.env.MANUS_API_KEY.trim());
  return [...new Set(keys)];
}

async function manusFetch(path, { method = "GET", body, apiKey, controller, timeoutMs = 10000 }) {
  const res = await fetchWithTimeout(`${MANUS_BASE}${path}`, {
    method,
    headers: { "x-manus-api-key": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, timeoutMs, controller);
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok || data?.ok === false) {
    const err = taggedError("http", `Manus responded with HTTP ${res.status}${data?.error?.message ? `: ${String(data.error.message).slice(0, 200)}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function manusStopTask(taskId, apiKey) {
  // Best-effort, never awaited by callers: stop (or delete) the task so a
  // failed/abandoned run doesn't keep burning credits.
  const c = new AbortController();
  manusFetch("/v2/task.stop", { method: "POST", body: { task_id: taskId }, apiKey, controller: c, timeoutMs: 5000 }).catch(() => {});
}

async function tryManus({ system, prompt, apiKey, controller, deadline }) {
  let text = `${MANUS_PREAMBLE}${system ? `${system}\n\n---\n\n` : ""}${prompt}`;
  if (text.length > MANUS_MAX_INPUT_CHARS) {
    console.warn(`[manus] input was ${text.length} chars; trimming to ${MANUS_MAX_INPUT_CHARS} to fit Manus's input limit`);
    // Keep the start (instructions + data) and the end (output-format rules).
    const tail = 2500;
    text = `${text.slice(0, MANUS_MAX_INPUT_CHARS - tail - 40)}\n…[trimmed]…\n${text.slice(-tail)}`;
  }

  const created = await manusFetch("/v2/task.create", {
    method: "POST",
    apiKey,
    controller,
    body: {
      message: { content: text },
      agent_profile: MANUS_AGENT_PROFILE,
      interactive_mode: false,
      hide_in_task_list: MANUS_HIDE_TASKS,
      title: "VertexRank analysis",
    },
  });
  const taskId = created?.task_id;
  if (!taskId) throw taggedError("empty", "Manus did not return a task id");

  let stoppedWithoutAnswer = 0;
  try {
    while (Date.now() < deadline) {
      await sleepAbortable(MANUS_POLL_MS, controller.signal);
      const data = await manusFetch(`/v2/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=20`, { apiKey, controller });
      const msgs = Array.isArray(data?.messages) ? data.messages : [];

      const errMsg = msgs.find((m) => m.type === "error_message");
      if (errMsg) throw taggedError("http", `Manus task error: ${errMsg.error_message?.content || errMsg.error_message?.error_type || "unknown"}`);

      const status = msgs.find((m) => m.type === "status_update")?.status_update?.agent_status;
      if (status === "error") throw taggedError("http", "Manus task ended with an error");
      if (status === "waiting") {
        manusStopTask(taskId, apiKey);
        throw taggedError("http", "Manus agent paused waiting for input instead of answering");
      }
      if (status === "stopped") {
        const answers = msgs.filter((m) => m.type === "assistant_message" && m.assistant_message?.content);
        const best = answers.find((m) => m.assistant_message.delivery_kind === "result") || answers[0];
        if (best) {
          if (MANUS_DELETE_TASKS) manusFetch("/v2/task.delete", { method: "POST", body: { task_id: taskId }, apiKey, controller: new AbortController(), timeoutMs: 5000 }).catch(() => {});
          return { content: best.assistant_message.content.trim(), label: `manus:${MANUS_AGENT_PROFILE}` };
        }
        // Stopped but no answer visible yet — give it a few more polls.
        if (++stoppedWithoutAnswer >= 4) throw taggedError("empty", "Manus finished without returning an answer");
      }
    }
    manusStopTask(taskId, apiKey);
    throw taggedError("timeout", "Manus didn't finish in time");
  } catch (err) {
    if (err?.name === "AbortError") { manusStopTask(taskId, apiKey); }
    throw err;
  }
}

const TOKENHARBOR_URL = process.env.TOKENHARBOR_BASE_URL || "https://tokenharbor.ai/v1/chat/completions";
const TOKENHARBOR_DEFAULT_MODELS = [
  "claude-haiku-5.5:free",
  "deepseek-v4.1-flash:free",
  "mimo-v2.6-flash:free",
];
// Delay (ms) before each successive model is started within one key's stage.
const TOKENHARBOR_HEDGE_MS = 3000;

function parseList(raw) {
  return (raw || "").split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
}

function getTokenHarborModels() {
  const custom = parseList(process.env.TOKENHARBOR_MODELS);
  return custom.length ? custom : TOKENHARBOR_DEFAULT_MODELS;
}

/** Token Harbor key pool: TOKENHARBOR_API_KEYS (comma/newline separated),
 * else the singular TOKENHARBOR_API_KEY. De-duplicated. */
function getTokenHarborKeyPool() {
  const keys = parseList(process.env.TOKENHARBOR_API_KEYS);
  if (!keys.length && process.env.TOKENHARBOR_API_KEY) keys.push(process.env.TOKENHARBOR_API_KEY.trim());
  return [...new Set(keys)];
}

// key -> timestamp (ms) until which the key is skipped. Best-effort, lives
// only as long as one warm serverless instance, which is all we need.
const tokenHarborCooldown = new Map();
let tokenHarborKeyCursor = 0;

function markTokenHarborFailures(key, errors) {
  const statuses = errors.map((e) => e?.status).filter(Boolean);
  if (statuses.includes(401)) {
    tokenHarborCooldown.set(key, Date.now() + 10 * 60 * 1000); // bad/revoked key
  } else if (statuses.includes(403)) {
    tokenHarborCooldown.set(key, Date.now() + 60 * 1000); // forbidden (may be fixable in the dashboard)
  } else if (statuses.includes(429) || statuses.includes(402)) {
    tokenHarborCooldown.set(key, Date.now() + 60 * 1000); // rate/allowance limit
  }
}

function sleepAbortable(ms, signal) {
  return new Promise((resolve, reject) => {
    const abortErr = () => { const e = new Error("aborted"); e.name = "AbortError"; return e; };
    if (signal.aborted) return reject(abortErr());
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(abortErr()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const LLMSRELAY_ANTHROPIC_BASE = "https://api.llmsrelay.com";
const LLMSRELAY_OPENAI_BASE = "https://api.llmsrelay.com/v1";

// Configurable via env var in case your LLMsRelay plan is provisioned for a
// different model than these defaults.
const LLMSRELAY_ANTHROPIC_MODEL = process.env.LLMSRELAY_ANTHROPIC_MODEL || "claude-sonnet-4.6";
const LLMSRELAY_OPENAI_MODEL = process.env.LLMSRELAY_OPENAI_MODEL || "claude-sonnet-4.6";

// SPEED: analysis calls are structured-JSON tasks where output length, not
// reasoning depth, sets the wait. A smaller, faster Claude model writes the
// same JSON in roughly a third of the time. Every JSON call tries this model
// first and silently falls back to the standard one above if it errors,
// times out, or returns unusable JSON, so a wrong/unavailable model id costs
// a few seconds once instead of breaking the analysis. Set
// LLMSRELAY_FAST_MODEL to another model id to change it, or to "off" to
// always use the standard model.
const FAST_MODEL_RAW = process.env.LLMSRELAY_FAST_MODEL;
const LLMSRELAY_FAST_MODEL = FAST_MODEL_RAW === undefined || FAST_MODEL_RAW === "" ? "claude-haiku-4.5" : FAST_MODEL_RAW;
const FAST_MODEL_ENABLED = !/^(off|none|false|0)$/i.test(LLMSRELAY_FAST_MODEL);

const MODEL_CHAIN = [
  "thinkingmachines/inkling-small:free",
  "thinkingmachines/inkling:free",
  "inclusionai/ling-3.0-flash-vl:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/free",
];

/** Reads the OpenRouter key pool from env: OPENROUTER_API_KEYS (comma or
 * newline separated) takes priority; falls back to the singular
 * OPENROUTER_API_KEY for existing single-key deployments. Returns [] if
 * neither is set. */
function getOpenRouterKeyPool() {
  const list = process.env.OPENROUTER_API_KEYS;
  if (list) {
    const keys = list.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
    if (keys.length) return keys;
  }
  return process.env.OPENROUTER_API_KEY ? [process.env.OPENROUTER_API_KEY] : [];
}

// Round-robins the starting key across invocations (best-effort: persists
// only within one warm serverless instance, which is fine — the goal is
// just to spread load rather than always hammering key #1 first, not to
// guarantee perfect global rotation).
let openRouterKeyCursor = 0;

async function fetchWithTimeout(url, options, timeoutMs, controller) {
  const c = controller || new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: c.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort cleanup of a model's raw text before JSON.parse: strips
 * markdown code fences, trims to the outermost {...} block, and drops
 * trailing commas (the single most common model JSON mistake). Does NOT
 * attempt to repair unescaped quotes or literal line breaks inside string
 * values — those are unsafe to "fix" with regex, so a response with that
 * problem is treated as a parse failure and the caller falls through to the
 * next provider/model instead. */
function cleanJsonText(text) {
  let t = text.trim();
  t = t.replace(/```(?:json)?/gi, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  t = t.slice(start, end + 1);
  t = t.replace(/,(\s*[}\]])/g, "$1");
  return t;
}

export function parseModelJson(text) {
  const cleaned = cleanJsonText(text);
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

const JSON_FORMAT_REMINDER = `
Formatting rules, critical: respond with ONLY a single valid JSON object. No markdown code fences, no commentary before or after. Every string value must be written on a single line — never include a literal line break inside a string, use spaces instead. Escape any double-quote character that appears inside a string value with a backslash. Do not add a trailing comma before a closing } or ].`;

const JSON_RETRY_REMINDER = `
Your previous response was not usable — it did not consist of ONLY the requested JSON object. This is a strict requirement: respond with NOTHING but the JSON object itself. No greeting, no explanation, no markdown fences, no text before or after the JSON.`;

/** LLMsRelay's native Anthropic-format endpoint. */
async function tryLlmsRelayAnthropic({ system, prompt, maxTokens, temperature, apiKey, timeoutMs, controller, model = LLMSRELAY_ANTHROPIC_MODEL }) {
  const res = await fetchWithTimeout(`${LLMSRELAY_ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  }, timeoutMs, controller);

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw taggedError("http", `LLMsRelay (Anthropic endpoint, ${model}) responded with HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
  }
  const data = await res.json();
  const content = Array.isArray(data?.content)
    ? data.content.map((b) => b?.text || "").join("").trim()
    : "";
  if (!content) throw taggedError("empty", "LLMsRelay (Anthropic endpoint) returned an empty response");
  return { content, label: `llmsrelay:${model}` };
}

/** LLMsRelay's OpenAI-compatible endpoint (still serves Claude models, via
 * the standard chat-completions request/response shape). */
async function tryLlmsRelayOpenAI({ system, prompt, maxTokens, temperature, apiKey, timeoutMs, controller, model = LLMSRELAY_OPENAI_MODEL }) {
  const res = await fetchWithTimeout(`${LLMSRELAY_OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  }, timeoutMs, controller);

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw taggedError("http", `LLMsRelay (OpenAI-compatible endpoint, ${model}) responded with HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw taggedError("empty", "LLMsRelay (OpenAI-compatible endpoint) returned an empty response");
  return { content, label: `llmsrelay:${model}` };
}

async function tryOpenRouterModel(model, { system, prompt, maxTokens, temperature, apiKey, timeoutMs, controller }) {
  const res = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://vertexrank.app",
      "X-Title": "VertexRank",
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  }, timeoutMs, controller);

  if (!res.ok) throw taggedError("http", `${model} responded with HTTP ${res.status}`);
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw taggedError("empty", `${model} returned an empty response`);
  return { content, label: model };
}

async function tryTokenHarborModel(model, { system, prompt, maxTokens, temperature, apiKey, timeoutMs, controller, delayMs = 0, keyState }) {
  if (delayMs > 0) await sleepAbortable(delayMs, controller.signal);
  if (keyState?.dead) {
    // An earlier model already got a key-level rejection (429/401/403) —
    // don't spend more requests on this key.
    const err = taggedError("http", keyState.reason || `Token Harbor key unavailable (HTTP ${keyState.dead})`);
    err.status = keyState.dead;
    throw err;
  }
  const res = await fetchWithTimeout(TOKENHARBOR_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "VertexRank/1.0 (+https://vertexrank.app)",
    },
    body: JSON.stringify({
      model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
      max_tokens: maxTokens,
      temperature,
    }),
  }, timeoutMs, controller);

  if (!res.ok) {
    // Surface Token Harbor's own explanation (e.g. "free models need opt-in",
    // "invalid key", "insufficient balance") instead of just the status code.
    const bodyText = await res.text().catch(() => "");
    const err = taggedError("http", `Token Harbor (${model}) responded with HTTP ${res.status}${bodyText ? `: ${bodyText.replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
    err.status = res.status;
    // 401/402/429 are about the key/account, so skip the rest of this key's
    // models. 403 can be model-specific, so let the other models try.
    if (keyState && [401, 402, 429].includes(res.status)) { keyState.dead = res.status; keyState.reason = err.message; }
    throw err;
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;
  const content = (typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((b) => b?.text || "").join("") : "").trim();
  if (!content) throw taggedError("empty", `Token Harbor (${model}) returned an empty response`);
  return { content, label: `tokenharbor:${model}` };
}

function taggedError(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

/** Runs a set of attempt-thunks concurrently and returns whichever settles
 * first with a result `validate` accepts. Each thunk receives its own
 * AbortController; once a winner is found, every other in-flight
 * controller in the stage is aborted, so losing requests don't keep
 * running (and burning provider quota) after we've already moved on.
 *
 * validate(content) => { ok: true, value } | { ok: false, error: string }
 *
 * Resolves to { ok: true, value, label } on success, or
 * { ok: false, errors: Error[] } if every attempt failed — `errors` is
 * every individual failure (network, timeout, empty, or invalid-JSON),
 * not just the last one, so callers can tell *why* a stage failed as a
 * whole (e.g. "all timeouts" vs "reachable but bad format").
 */
function raceStage(rawAttempts, validate) {
  if (rawAttempts.length === 0) return Promise.resolve({ ok: false, errors: [] });

  const controllers = rawAttempts.map(() => new AbortController());
  const abortOthers = (winnerIdx) => {
    controllers.forEach((c, i) => { if (i !== winnerIdx) c.abort(); });
  };

  const wrapped = rawAttempts.map((make, i) => (async () => {
    let content, label;
    try {
      ({ content, label } = await make(controllers[i]));
    } catch (err) {
      throw err?.name === "AbortError" ? taggedError("timeout", "A provider took too long to respond") : err;
    }
    const v = validate(content);
    if (!v.ok) {
      const err = taggedError("json", v.error);
      err.rawSnippet = content.slice(0, 200);
      throw err;
    }
    abortOthers(i);
    return { value: v.value, label };
  })());

  return Promise.any(wrapped).then(
    ({ value, label }) => ({ ok: true, value, label }),
    (aggErr) => ({ ok: false, errors: aggErr?.errors || [aggErr] })
  );
}

const nonEmptyValidate = (content) => (content ? { ok: true, value: content } : { ok: false, error: "returned an empty response" });
const jsonValidate = (content) => {
  const parsed = parseModelJson(content);
  return parsed ? { ok: true, value: parsed } : { ok: false, error: "returned a response that wasn't valid JSON" };
};

/** True if at least one failure in the stage was specifically an
 * invalid-JSON reply (provider was reachable, just answered wrong) rather
 * than purely timeouts/network/HTTP errors. Only in that case is an
 * immediate same-provider retry likely to help. */
function hasJsonFormatFailure(errors) {
  return errors.some((e) => e?.kind === "json");
}

function pickPrimaryError(errors) {
  if (!errors.length) return null;
  return errors.find((e) => e?.kind === "json") || errors[errors.length - 1];
}

async function runPipeline({ system, prompt, maxTokens, temperature, perModelTimeoutMs, overallBudgetMs, validate, fast = false }) {
  const start = Date.now();
  const llmsRelayKey = PROVIDERS.llmsrelay ? process.env.LLMSRELAY_API_KEY : undefined;
  const openRouterKeys = PROVIDERS.openrouter ? getOpenRouterKeyPool() : [];
  const tokenHarborKeys = PROVIDERS.tokenharbor ? getTokenHarborKeyPool() : [];
  const manusKeys = PROVIDERS.manus ? getManusKeyPool() : [];

  if (!manusKeys.length && !tokenHarborKeys.length && !llmsRelayKey && !openRouterKeys.length) {
    const enabled = Object.entries(PROVIDERS).filter(([, on]) => on).map(([n]) => n);
    throw new Error(`No AI provider is usable. Enabled in code: ${enabled.join(", ") || "none"}. ${PROVIDERS.manus ? "Add MANUS_API_KEY in your environment variables and redeploy." : "Enable a provider in the PROVIDERS switches in lib/openrouter.js and make sure its API key is set."}`);
  }

  let errors = [];

  if (manusKeys.length) {
    // Manus (trial): one task per attempt, no racing — each task spends
    // credits and runs for many seconds. Rotate keys; on a key-level failure
    // (401/402/403/429) try the next key. Budget is longer than the other
    // providers because an agent task is slow, but stays under Vercel's 60s.
    const manusDeadline = start + Math.min(Math.max(overallBudgetMs, MANUS_TIMEOUT_MS), 55000);
    const startIdx = manusKeyCursor % manusKeys.length;
    manusKeyCursor = (manusKeyCursor + 1) % manusKeys.length;
    for (let i = 0; i < manusKeys.length; i++) {
      if (Date.now() >= manusDeadline) break;
      const key = manusKeys[(startIdx + i) % manusKeys.length];
      const attempt = (sys) => raceStage([(controller) => tryManus({ system: sys, prompt, apiKey: key, controller, deadline: manusDeadline })], validate);
      const rm = await attempt(system);
      if (rm.ok) return { value: rm.value, label: rm.label };
      errors = rm.errors;
      // Wrong-format reply (agent got chatty): one nudged retry if there's time left.
      if (hasJsonFormatFailure(errors) && manusDeadline - Date.now() > 20000) {
        const rm2 = await attempt(`${system}${JSON_RETRY_REMINDER}`);
        if (rm2.ok) return { value: rm2.value, label: rm2.label };
        errors = rm2.errors;
      }
      if (!errors.some((e) => [401, 402, 403, 429].includes(e?.status))) break; // not key-specific: another key won't help
    }
  }

  if (tokenHarborKeys.length) {
    // Stage 0 (default): Token Harbor free tier. Rotate the starting key,
    // skip keys that are cooling down (unless every key is), and on each key
    // hedge the free models (see header). A failed key moves on to the next.
    const now = Date.now();
    const startIdx = tokenHarborKeyCursor % tokenHarborKeys.length;
    tokenHarborKeyCursor = (tokenHarborKeyCursor + 1) % tokenHarborKeys.length;
    const ordered = tokenHarborKeys.map((_, i) => tokenHarborKeys[(startIdx + i) % tokenHarborKeys.length]);
    const healthy = ordered.filter((k) => (tokenHarborCooldown.get(k) || 0) <= now);
    const keysToTry = healthy.length ? healthy : ordered;
    const models = getTokenHarborModels();

    for (const key of keysToTry) {
      if (Date.now() - start >= overallBudgetMs) break;
      const keyState = { dead: 0 };
      const makeStage = (sys) => models.map((model, idx) => (controller) =>
        tryTokenHarborModel(model, { system: sys, prompt, maxTokens, temperature, apiKey: key, timeoutMs: perModelTimeoutMs, controller, delayMs: idx * TOKENHARBOR_HEDGE_MS, keyState })
      );
      const r0 = await raceStage(makeStage(system), validate);
      if (r0.ok) return { value: r0.value, label: r0.label };
      errors = r0.errors;
      markTokenHarborFailures(key, errors);

      // Reachable but answered in the wrong format: one nudged retry on the
      // same key before moving on (not for rate-limit/outage failures).
      if (hasJsonFormatFailure(errors) && Date.now() - start < overallBudgetMs) {
        const r0b = await raceStage(makeStage(`${system}${JSON_RETRY_REMINDER}`), validate);
        if (r0b.ok) return { value: r0b.value, label: r0b.label };
        errors = r0b.errors;
        markTokenHarborFailures(key, errors);
      }
    }
  }

  if (llmsRelayKey) {
    // Stage 1: race both LLMsRelay endpoints. Same provider/key, so this is
    // essentially free — and means one endpoint's occasional glitch doesn't
    // stall or fail the request as long as the other answers cleanly.
    // With `fast`, the whole stage runs on the fast model first; only if it
    // fails outright do we repeat it on the standard model.
    const modelPairs = [];
    if (fast && FAST_MODEL_ENABLED) modelPairs.push({ anthropic: LLMSRELAY_FAST_MODEL, openai: LLMSRELAY_FAST_MODEL });
    modelPairs.push({ anthropic: LLMSRELAY_ANTHROPIC_MODEL, openai: LLMSRELAY_OPENAI_MODEL });

    for (const m of modelPairs) {
      if (Date.now() - start >= overallBudgetMs) break;
      const stage1 = [
        (controller) => tryLlmsRelayAnthropic({ system, prompt, maxTokens, temperature, apiKey: llmsRelayKey, timeoutMs: perModelTimeoutMs, controller, model: m.anthropic }),
        (controller) => tryLlmsRelayOpenAI({ system, prompt, maxTokens, temperature, apiKey: llmsRelayKey, timeoutMs: perModelTimeoutMs, controller, model: m.openai }),
      ];
      const r1 = await raceStage(stage1, validate);
      if (r1.ok) return { value: r1.value, label: r1.label };
      errors = r1.errors;

      // Stage 1b: only if the failure was specifically a bad-format reply
      // (provider reachable, just answered wrong) — a pure timeout/outage
      // skips ahead instead, since retrying a down endpoint just spends
      // time without helping.
      if (hasJsonFormatFailure(errors) && Date.now() - start < overallBudgetMs) {
        const nudgedSystem = `${system}${JSON_RETRY_REMINDER}`;
        const stage1b = [
          (controller) => tryLlmsRelayAnthropic({ system: nudgedSystem, prompt, maxTokens, temperature, apiKey: llmsRelayKey, timeoutMs: perModelTimeoutMs, controller, model: m.anthropic }),
          (controller) => tryLlmsRelayOpenAI({ system: nudgedSystem, prompt, maxTokens, temperature, apiKey: llmsRelayKey, timeoutMs: perModelTimeoutMs, controller, model: m.openai }),
        ];
        const r1b = await raceStage(stage1b, validate);
        if (r1b.ok) return { value: r1b.value, label: r1b.label };
        errors = r1b.errors;
      }
    }
  }

  if (openRouterKeys.length) {
    // Stage 2 (fallback): walk the OpenRouter key pool starting from a
    // rotating offset, one key at a time — NOT all keys at once, which
    // would fire keys.length × MODEL_CHAIN.length requests simultaneously
    // and blow every key's per-minute limit in one shot. For each key, race
    // its whole free-model chain as before; if that key's stage fails
    // entirely (e.g. HTTP 429 on every model — that key's quota is spent),
    // move to the next key in the pool, until one succeeds or the overall
    // time budget runs out.
    const startIdx = openRouterKeyCursor % openRouterKeys.length;
    openRouterKeyCursor = (openRouterKeyCursor + 1) % openRouterKeys.length;

    for (let i = 0; i < openRouterKeys.length; i++) {
      if (Date.now() - start >= overallBudgetMs) break;
      const key = openRouterKeys[(startIdx + i) % openRouterKeys.length];
      const stage2 = MODEL_CHAIN.map((model) => (controller) =>
        tryOpenRouterModel(model, { system, prompt, maxTokens, temperature, apiKey: key, timeoutMs: perModelTimeoutMs, controller })
      );
      const r2 = await raceStage(stage2, validate);
      if (r2.ok) return { value: r2.value, label: r2.label };
      errors = r2.errors;
    }
  }

  const primary = pickPrimaryError(errors);
  const suffix = primary?.rawSnippet ? ` It said: "${primary.rawSnippet}${primary.rawSnippet.length >= 200 ? "…" : ""}"` : "";
  throw new Error(primary ? `VertexRank AI couldn't get a usable result (${primary.message}).${suffix} Try again.` : "None of the available providers returned a usable result. Try again.");
}

/** Returns raw text content from the first attempt that succeeds (HTTP ok +
 * non-empty response), racing LLMsRelay's two endpoints first, then
 * falling back to the OpenRouter chain. */
export async function callOpenRouter({ system, prompt, maxTokens = 700, temperature = 0.5, perModelTimeoutMs = 12000, overallBudgetMs = 42000 }) {
  const { value, label } = await runPipeline({ system, prompt, maxTokens, temperature, perModelTimeoutMs, overallBudgetMs, validate: nonEmptyValidate });
  return { content: value, model: label };
}

/** Like callOpenRouter, but validates that each attempt's response is
 * actually parseable JSON before accepting it. A malformed or truncated
 * response from one provider is treated as a failure and other attempts
 * (raced concurrently, then the next stage) are tried instead of
 * surfacing a raw parse error to the user after a single attempt. */
export async function callOpenRouterJson({ system, prompt, maxTokens = 900, temperature = 0.5, perModelTimeoutMs = 12000, overallBudgetMs = 42000, fast = true }) {
  const fullSystem = `${system || ""}${JSON_FORMAT_REMINDER}`;
  const { value } = await runPipeline({ system: fullSystem, prompt, maxTokens, temperature, perModelTimeoutMs, overallBudgetMs, validate: jsonValidate, fast });
  return value;
}

export function extractJson(text) {
  const parsed = parseModelJson(text);
  if (!parsed) throw new Error("The model didn't return a parseable result. Try again.");
  return parsed;
}
