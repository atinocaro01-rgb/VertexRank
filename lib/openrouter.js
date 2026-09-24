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
// Priority order, unchanged:
//   1. LLMsRelay — native Anthropic Messages API (api.llmsrelay.com/v1/messages)
//   2. LLMsRelay — OpenAI-compatible endpoint    (api.llmsrelay.com/v1/chat/completions)
//   3. OpenRouter free-model chain (5 models, final fallback)
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

const LLMSRELAY_ANTHROPIC_BASE = "https://api.llmsrelay.com";
const LLMSRELAY_OPENAI_BASE = "https://api.llmsrelay.com/v1";

// Configurable via env var in case your LLMsRelay plan is provisioned for a
// different model than these defaults.
const LLMSRELAY_ANTHROPIC_MODEL = process.env.LLMSRELAY_ANTHROPIC_MODEL || "claude-sonnet-4.6";
const LLMSRELAY_OPENAI_MODEL = process.env.LLMSRELAY_OPENAI_MODEL || "claude-sonnet-4.6";

const MODEL_CHAIN = [
  "thinkingmachines/inkling-small:free",
  "thinkingmachines/inkling:free",
  "inclusionai/ling-3.0-flash-vl:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/free",
];

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
async function tryLlmsRelayAnthropic({ system, prompt, maxTokens, temperature, apiKey, timeoutMs, controller }) {
  const res = await fetchWithTimeout(`${LLMSRELAY_ANTHROPIC_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: LLMSRELAY_ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      temperature,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  }, timeoutMs, controller);

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw taggedError("http", `LLMsRelay (Anthropic endpoint, ${LLMSRELAY_ANTHROPIC_MODEL}) responded with HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
  }
  const data = await res.json();
  const content = Array.isArray(data?.content)
    ? data.content.map((b) => b?.text || "").join("").trim()
    : "";
  if (!content) throw taggedError("empty", "LLMsRelay (Anthropic endpoint) returned an empty response");
  return { content, label: `llmsrelay:${LLMSRELAY_ANTHROPIC_MODEL}` };
}

/** LLMsRelay's OpenAI-compatible endpoint (still serves Claude models, via
 * the standard chat-completions request/response shape). */
async function tryLlmsRelayOpenAI({ system, prompt, maxTokens, temperature, apiKey, timeoutMs, controller }) {
  const res = await fetchWithTimeout(`${LLMSRELAY_OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: LLMSRELAY_OPENAI_MODEL,
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
    throw taggedError("http", `LLMsRelay (OpenAI-compatible endpoint, ${LLMSRELAY_OPENAI_MODEL}) responded with HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw taggedError("empty", "LLMsRelay (OpenAI-compatible endpoint) returned an empty response");
  return { content, label: `llmsrelay:${LLMSRELAY_OPENAI_MODEL}` };
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

async function runPipeline({ system, prompt, maxTokens, temperature, perModelTimeoutMs, overallBudgetMs, validate }) {
  const start = Date.now();
  const llmsRelayKey = process.env.LLMSRELAY_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  if (!llmsRelayKey && !openRouterKey) {
    throw new Error("No AI provider is configured. Add LLMSRELAY_API_KEY (preferred) or OPENROUTER_API_KEY in your environment variables, then redeploy.");
  }

  let errors = [];

  if (llmsRelayKey) {
    // Stage 1: race both LLMsRelay endpoints. Same provider/key, so this is
    // essentially free — and means one endpoint's occasional glitch doesn't
    // stall or fail the request as long as the other answers cleanly.
    const stage1 = [
      (controller) => tryLlmsRelayAnthropic({ system, prompt, maxTokens, temperature, apiKey: llmsRelayKey, timeoutMs: perModelTimeoutMs, controller }),
      (controller) => tryLlmsRelayOpenAI({ system, prompt, maxTokens, temperature, apiKey: llmsRelayKey, timeoutMs: perModelTimeoutMs, controller }),
    ];
    const r1 = await raceStage(stage1, validate);
    if (r1.ok) return { value: r1.value, label: r1.label };
    errors = r1.errors;

    // Stage 1b: only if the failure was specifically a bad-format reply
    // (provider reachable, just answered wrong) — a pure timeout/outage
    // skips straight to the OpenRouter fallback instead, since retrying a
    // down endpoint just spends time without helping.
    if (hasJsonFormatFailure(errors) && Date.now() - start < overallBudgetMs) {
      const nudgedSystem = `${system}${JSON_RETRY_REMINDER}`;
      const stage1b = [
        (controller) => tryLlmsRelayAnthropic({ system: nudgedSystem, prompt, maxTokens, temperature, apiKey: llmsRelayKey, timeoutMs: perModelTimeoutMs, controller }),
        (controller) => tryLlmsRelayOpenAI({ system: nudgedSystem, prompt, maxTokens, temperature, apiKey: llmsRelayKey, timeoutMs: perModelTimeoutMs, controller }),
      ];
      const r1b = await raceStage(stage1b, validate);
      if (r1b.ok) return { value: r1b.value, label: r1b.label };
      errors = r1b.errors;
    }
  }

  if (openRouterKey && Date.now() - start < overallBudgetMs) {
    // Stage 2 (fallback): race the whole free-model chain at once instead
    // of trying them one at a time.
    const stage2 = MODEL_CHAIN.map((model) => (controller) =>
      tryOpenRouterModel(model, { system, prompt, maxTokens, temperature, apiKey: openRouterKey, timeoutMs: perModelTimeoutMs, controller })
    );
    const r2 = await raceStage(stage2, validate);
    if (r2.ok) return { value: r2.value, label: r2.label };
    errors = r2.errors;
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
export async function callOpenRouterJson({ system, prompt, maxTokens = 900, temperature = 0.5, perModelTimeoutMs = 12000, overallBudgetMs = 42000 }) {
  const fullSystem = `${system || ""}${JSON_FORMAT_REMINDER}`;
  const { value } = await runPipeline({ system: fullSystem, prompt, maxTokens, temperature, perModelTimeoutMs, overallBudgetMs, validate: jsonValidate });
  return value;
}

export function extractJson(text) {
  const parsed = parseModelJson(text);
  if (!parsed) throw new Error("The model didn't return a parseable result. Try again.");
  return parsed;
}
