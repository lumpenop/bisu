// Offline check of the key order (engine/routes.mjs) through GLM and Decisions, with a pretend server:
//   node engine/eval/routes-check.mjs
// The first key in the order answers "insufficient balance": the same request must go out with the next key, the empty
// one must rest (a new process skips it too), the switch turned off must keep to the first key, and Z.AI must get its
// own address and body.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bisu-routes-'));
Object.assign(process.env, {
  BISU_ROUTES_FILE: path.join(dir, 'model-routes.json'), BISU_ROUTE_HEALTH: path.join(dir, 'health.json'),
  BISU_ROUTE_KEYS: '1|GLM_API_KEY|https://api.z.ai;2|OPENROUTER_API_KEY|https://openrouter.ai;3|OR%20backup|https://openrouter.ai;4|OPENAI_API_KEY|https://api.openai.com;5|OAI%202|https://api.openai.com',
  BISU_RK1_API_KEY: 'zai', BISU_RK1_BASE_URL: 'http://z.local', BISU_RK2_API_KEY: 'or1', BISU_RK2_BASE_URL: 'http://or.local',
  BISU_RK3_API_KEY: 'or2', BISU_RK3_BASE_URL: 'http://or.local', BISU_RK4_API_KEY: 'oa1', BISU_RK4_BASE_URL: 'http://oa.local', BISU_RK5_API_KEY: 'oa2', BISU_RK5_BASE_URL: 'http://oa.local',
});
const R = await import('../routes.mjs'), {complete} = await import('../glm.mjs'), judge = await import('../judge.mjs');
const calls = [], empty = new Set();
const sse = text => new Response(`data: ${JSON.stringify({choices: [{delta: {content: text}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1}})}\n\ndata: [DONE]\n\n`, {status: 200});
globalThis.fetch = async (url, init) => {
  const key = init.headers.authorization.slice(7), body = JSON.parse(init.body);
  calls.push({url, key, model: body.model, reasoning: body.reasoning, effort: body.reasoning_effort});
  if (empty.has(key)) return new Response(JSON.stringify({error: {message: 'Insufficient balance'}}), {status: 429});
  if (/decisions$/.test(url)) return new Response(JSON.stringify({answers: [{name: 'q', type: 'predicate', probability: 0.9}], usage: {input_tokens: 5}}), {status: 200});
  return sse('ok');
};
const ask = () => complete({model: 'glm-5.3', thinking: false, messages: [{role: 'user', content: 'hi'}]});

// Default: OpenRouter before Z.AI.
assert.deepEqual(R.routes('glm').map(r => r.name), ['OPENROUTER_API_KEY', 'OR backup', 'GLM_API_KEY']);
// The person's order: Z.AI first. Z.AI is empty: the same request goes to OpenRouter, shaped for it.
R.save({family: 'glm', order: ['GLM_API_KEY', 'OPENROUTER_API_KEY']});
empty.add('zai');
assert.equal((await ask()).text, 'ok');
assert.deepEqual(calls.map(c => [c.url, c.key]), [['http://z.local/api/paas/v4/chat/completions', 'zai'], ['http://or.local/api/v1/chat/completions', 'or1']]);
assert.equal(calls[0].model, 'glm-5.3'); assert.equal(calls[1].model, 'z-ai/glm-5.3'); assert.deepEqual(calls[1].reasoning, {effort: 'medium'});
// It rests: the next request (or the next chat's process) starts with OpenRouter.
assert.ok(R.resting('GLM_API_KEY')); assert.equal(R.routes('glm').at(-1).name, 'GLM_API_KEY');
calls.length = 0; await ask(); assert.deepEqual(calls.map(c => c.key), ['or1']);
// The switch off: only the first key, and its error comes back.
R.save({auto: false}); R.rest('GLM_API_KEY', 0); calls.length = 0;
await assert.rejects(ask(), /balance/i); assert.deepEqual(calls.map(c => c.key), ['zai']);
R.save({auto: true}); R.rest('GLM_API_KEY', 0);
// Decisions: the first OpenAI key is empty, the second answers.
empty.add('oa1'); calls.length = 0;
const a = await judge.ask('text', [{type: 'predicate', name: 'q', instructions: 'yes?'}]);
assert.equal(a?.q, 0.9); assert.deepEqual(calls.map(c => [c.url, c.key]), [['http://oa.local/v1/decisions', 'oa1'], ['http://oa.local/v1/decisions', 'oa2']]);
console.log('routes-check: all good');
fs.rmSync(dir, {recursive: true, force: true});
