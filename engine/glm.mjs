// Z.ai GLM over its OpenAI-compatible endpoint: one streamed chat completion at a time.
//
// The engine never holds the key itself: in development `dec-secret run` gives it a one-time token
// and a local base URL (GLM_BASE_URL); in the shipped app the base URL is bisu's own server. The
// default below is Z.ai's general API, billed to a Standard key (a Coding Plan key may not be used
// from an app).
//
// complete() streams: text and reasoning arrive through callbacks as they come, tool calls are
// assembled from their fragments, and the result carries the usage from the final chunk.

// The keys GLM can go out with, in the person's order (routes.mjs, shared with dec): OpenRouter serves the same models
// (z-ai/glm-5.3 …) under its own key, Z.ai serves them directly. A key that fails before anything streamed (no balance,
// refused, busy, down) hands the same request to the next one when the switch is on; GLM_VIA=openrouter still puts
// OpenRouter first.
import * as R from './routes.mjs';
const glmRoutes = () => { const rs = R.routes('glm'); return process.env.GLM_VIA === 'openrouter' ? [...rs.filter(r => r.site === R.OR_SITE), ...rs.filter(r => r.site !== R.OR_SITE)] : rs };
let lastRoute = null;
export const viaOpenRouter = () => (lastRoute || glmRoutes()[0])?.site === R.OR_SITE;
const base = r => r.base.replace(/\/$/, '') + (r.site === R.ZAI_SITE ? '/api/paas/v4' : '/api/v1');
// Z.ai's fields in OpenRouter's words: the model under its maker, reasoning off or at an effort.
function wire(body, r) {
  if (r.site !== R.OR_SITE) return body;
  const {thinking, reasoning_effort, tool_stream, ...b} = body;
  if (!b.model.includes('/')) b.model = 'z-ai/' + b.model;
  if (thinking?.type === 'disabled') b.reasoning = {enabled: false};
  else if (reasoning_effort) b.reasoning = {effort: reasoning_effort};
  return b;
}

// USD per 1M tokens (Z.ai pricing, 2026-10). Cost is computed here because the API returns usage only.
export const PRICES = {
  'glm-5.3': {input: 1.40, cached: 0.26, output: 4.40},
  'glm-5.3-flashx': {input: 0.37, cached: 0.07, output: 1.25},
  'glm-5.3-flash': {input: 0.15, cached: 0.03, output: 0.50},
};
export function costOf(model, usage) {
  if (usage?.cost != null) return usage.cost;
  const p = PRICES[model];
  if (!p || !usage) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens || 0;
  return ((usage.prompt_tokens - cached) * p.input + cached * p.cached + (usage.completion_tokens || 0) * p.output) / 1e6;
}

// Models that refuse thinking:disabled, learned from their 400 and remembered for the process.
const ALWAYS_THINKS = new Set(['glm-5.3']);

// A model stuck saying the same thing ("done done done …") would otherwise stream until max_tokens:
// once on the benchmark, GLM-5.3 did it for 19 minutes and 65k tokens. The tail is checked every few
// hundred characters: the same short piece over and over, or almost no distinct words.
export function looping(s) {
  if (s.length < 800) return false;
  const tail = s.slice(-1200);
  for (let k = 1; k <= 40; k++) if (tail.length >= 400 + k && tail.slice(-400) === tail.slice(-400 - k, -k)) return true;
  const words = tail.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w));
  return words.length >= 120 && new Set(words).size / words.length < 0.12;
}

export class GLMError extends Error {
  constructor(message, {status = 0, retryable = false, code = ''} = {}) { super(message); this.status = status; this.retryable = retryable; this.code = code }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason || new Error('aborted')) }, {once: true});
});

// One request, retried on 429 and 5xx (and on a dropped connection before anything streamed).
// onText/onReasoning get each fragment; nothing is retried once text has been shown.
export async function complete({model, messages, tools, thinking = true, effort, maxTokens, temperature, signal, onText, onReasoning, onToolStart}) {
  const body = {model, messages, stream: true, tool_stream: !!tools?.length};
  if (tools?.length) body.tools = tools;
  // Flash can switch reasoning off; GLM-5.3 always reasons and takes an effort level instead.
  // (effort: how hard a model that always reasons does — 「보통」 unless the caller says otherwise: at 「낮음」 GLM-5.3 got
  // simple comparisons wrong, and its tokens are cheap)
  if (!thinking) { if (ALWAYS_THINKS.has(model)) body.reasoning_effort = effort || 'medium'; else body.thinking = {type: 'disabled'} }
  if (maxTokens) body.max_tokens = maxTokens;
  if (temperature != null) body.temperature = temperature;
  let attempt = 0, at = 0;
  const list = glmRoutes(), auto = R.settings().auto;
  if (!list.length) throw new GLMError('GLM 키가 없어요: Dec에 OpenRouter나 Z.AI 키를 저장해 주세요.', {status: 401, code: 'no_key'});
  for (;;) {
    attempt++;
    let streamed = false;
    const route = lastRoute = list[at];
    try {
      const out = await once(body, route, signal, {onText: t => { streamed = true; onText?.(t) }, onReasoning, onToolStart});
      if (R.resting(route.name)) R.rest(route.name, 0);
      return out;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof GLMError && e.status === 400 && /cannot be disabled/.test(e.message) && body.thinking?.type === 'disabled') {
        ALWAYS_THINKS.add(model); delete body.thinking; body.reasoning_effort = effort || 'medium'; attempt--; continue;
      }
      // This key failed before anything was shown: the next key takes the same request (and this one rests).
      const status = e instanceof GLMError ? e.status : 0;
      if (!streamed && (status ? R.failover(status) : !(e instanceof GLMError))) {
        R.rest(route.name, status ? R.restFor(status, e.message) : 60_000);
        if (auto && at < list.length - 1) { at++; attempt--; continue }
        // (no money or refused: asking the same key again changes nothing)
        if (status && R.restFor(status, e.message) > 60_000) throw e;
      }
      const retryable = e instanceof GLMError ? e.retryable : true;
      if (!retryable || streamed || attempt >= 4) throw e;
      await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)) + Math.random() * 300, signal);
    }
  }
}

async function once(body, route, signal, {onText, onReasoning, onToolStart}) {
  const t0 = Date.now();
  const r = await fetch(base(route) + '/chat/completions', {
    method: 'POST', signal,
    headers: {authorization: 'Bearer ' + route.key, 'content-type': 'application/json', accept: 'text/event-stream'},
    body: JSON.stringify(wire(body, route)),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    let msg = text.slice(0, 300);
    try { const j = JSON.parse(text); msg = j.error?.message || j.msg || msg } catch {}
    throw new GLMError(`GLM ${r.status}: ${msg}`, {status: r.status, retryable: r.status === 429 || r.status >= 500});
  }
  let text = '', reasoning = '', finish = null, usage = null, firstAt = 0, looped = false, seenText = 0, seenReasoning = 0;
  const calls = []; // by index: {id, name, arguments}
  const dec = new TextDecoder();
  let buf = '';
  read: for await (const chunk of r.body) {
    buf += dec.decode(chunk, {stream: true});
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data) } catch { continue }
      if (j.error) throw new GLMError(`GLM: ${j.error.message || JSON.stringify(j.error)}`, {retryable: false});
      if (j.usage) usage = j.usage;
      const c = j.choices?.[0];
      if (!c) continue;
      const d = c.delta || {};
      if (!firstAt && (d.content || d.reasoning_content || d.tool_calls)) firstAt = Date.now();
      const rc = d.reasoning_content || d.reasoning;
      if (!firstAt && rc) firstAt = Date.now();
      if (rc) { reasoning += rc; onReasoning?.(rc) }
      if (d.content) { text += d.content; onText?.(d.content) }
      for (const tc of d.tool_calls || []) {
        const at = tc.index ?? calls.length;
        const slot = calls[at] || (calls[at] = {id: '', name: '', arguments: ''});
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) { if (!slot.name) onToolStart?.(tc.function.name); slot.name += tc.function.name }
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      }
      if (c.finish_reason) finish = c.finish_reason;
      // Stop reading (which cancels the request) as soon as either stream goes round in circles.
      if (text.length - seenText >= 200 || reasoning.length - seenReasoning >= 400) {
        seenText = text.length; seenReasoning = reasoning.length;
        if (looping(text) || looping(reasoning)) { looped = true; break read }
      }
    }
  }
  if (looped) {
    // No usage arrives from a cancelled stream: estimate it from the characters, so the cost still counts.
    usage = {prompt_tokens: Math.round(JSON.stringify(body.messages).length / 3), completion_tokens: Math.round((text.length + reasoning.length) / 2), estimated: true};
    return {text: '', reasoning, toolCalls: [], finish: 'repetition', usage, cost: costOf(body.model, usage), ms: Date.now() - t0, firstMs: firstAt ? firstAt - t0 : null};
  }
  return {text, reasoning, toolCalls: calls.filter(Boolean).map((c, n) => ({...c, id: c.id || `call_${Date.now()}_${n}`})),
    finish, usage, cost: costOf(body.model, usage), ms: Date.now() - t0, firstMs: firstAt ? firstAt - t0 : null};
}
