// One turn of Dec Intern's own agent: the model speaks, calls tools, reads what they returned, and goes
// on until it answers without calling anything (or is stopped).
//
// Everything the page shows comes out of onEvent in the same shapes the Claude Code path produced
// (delta, text, tool, tool_result, result), so the page does not know which engine it is talking to.
// Permission is a callback: the caller decides — ask the person, apply a rule, or (in tests) allow.
import {complete} from './glm.mjs';
import {TOOLS, toolSpecs, parseArgs} from './tools.mjs';

const clipFor = (s, n = 4000) => s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s;

export async function runTurn({
  model, system, messages, tools = Object.keys(TOOLS), extraTools = {}, ctx,
  thinking = true, effort, maxSteps = 40, onEvent = () => {}, canUseTool = async () => ({allow: true}),
  shouldContinue = null, // stage 2: a judge that may stop a loop that is going nowhere
  checkAnswer = null,    // a judge that reads the answer against what the tools actually did
  onMessage = () => {},    // every message added to the conversation, for the transcript
}) {
  const all = {...TOOLS, ...extraTools};
  const specs = toolSpecs(tools, extraTools);
  const stats = {steps: 0, toolCalls: 0, invalid: 0, repeats: 0, denied: 0, empty: 0, nudges: 0, loops: 0, claimNudges: 0, actions: [], prompt: 0, completion: 0, cached: 0, reasoning: 0, cost: 0, firstMs: null, stop: 'done', text: ''};
  const seen = new Map();
  const t0 = Date.now();
  for (;;) {
    if (ctx.signal?.aborted) { stats.stop = 'stopped'; break }
    if (stats.steps >= maxSteps) { stats.stop = 'max_steps'; break }
    stats.steps++;
    let res;
    try {
      res = await complete({
        model, thinking, effort, tools: specs, signal: ctx.signal,
        messages: [{role: 'system', content: system}, ...messages],
        onText: t => onEvent({kind: 'delta', text: t}),
        onToolStart: name => onEvent({kind: 'tool_start', name}),
      });
    } catch (e) {
      if (ctx.signal?.aborted) { stats.stop = 'stopped'; break }
      stats.stop = 'error'; stats.error = e.message;
      onEvent({kind: 'error', message: e.message});
      break;
    }
    if (stats.firstMs == null) stats.firstMs = res.firstMs;
    const u = res.usage || {};
    stats.prompt += u.prompt_tokens || 0; stats.completion += u.completion_tokens || 0;
    stats.cached += u.prompt_tokens_details?.cached_tokens || 0; stats.reasoning += u.completion_tokens_details?.reasoning_tokens || 0;
    stats.cost += res.cost || 0;

    // Cut off for repeating itself: ask once for a fresh, short answer, then give up with a clear error.
    if (res.finish === 'repetition') {
      stats.loops++;
      if (stats.loops <= 1 && !ctx.signal?.aborted) {
        messages.push({role: 'user', content: '(dec-intern: 방금 답이 같은 말을 되풀이해서 끊었어. 처음부터 짧고 분명하게 다시 답해줘. 필요한 도구가 없으면 없다고 말해.)'});
        continue;
      }
      stats.stop = 'error'; stats.error = '모델이 같은 말을 되풀이해서 멈췄어요.';
      onEvent({kind: 'error', message: stats.error});
      break;
    }
    const calls = res.toolCalls;
    // GLM sometimes ends a turn with reasoning only: no text, no tool call. That is never an answer;
    // ask once more (twice at most) instead of leaving the person with nothing.
    if (!calls.length && !String(res.text || '').trim()) {
      stats.empty++;
      if (stats.empty <= 2 && !ctx.signal?.aborted) {
        messages.push({role: 'user', content: '(dec-intern: 방금 답이 비어 있었어. 지금까지 알아낸 것과 한 일을 바탕으로 사람에게 바로 답해줘. 일이 남았으면 이어서 해.)'});
        continue;
      }
    }
    const reply = {role: 'assistant', content: res.text || '', ...(calls.length ? {tool_calls: calls.map(c => ({id: c.id, type: 'function', function: {name: c.name, arguments: c.arguments}}))} : {})};
    messages.push(reply);
    onMessage(reply, {model, usage: res.usage, toolCalls: calls, text: res.text});
    if (res.text) { onEvent({kind: 'text', text: res.text}); stats.text = res.text }
    if (res.finish === 'sensitive') { stats.stop = 'filtered'; onEvent({kind: 'error', message: '모델의 안전 필터가 답을 멈췄어요.'}); break }
    if (!calls.length) {
      // An answer that says it did something no tool did this turn gets one chance to do it or say so.
      if (checkAnswer && !stats.claimNudges && res.text && !ctx.signal?.aborted) {
        const r = await checkAnswer({text: res.text, stats});
        if (r?.nudge) { stats.claimNudges++; messages.push({role: 'user', content: `(dec-intern: ${r.nudge})`}); continue }
      }
      break;
    }

    for (const c of calls) {
      stats.toolCalls++;
      const tool = all[c.name];
      const parsed = tool ? parseArgs(tool, c.arguments) : {error: `There is no tool called "${c.name}". Available: ${tools.join(', ')}.`};
      let text, error = false;
      if (parsed.error) {
        // A malformed call still shows on the page, so the person sees what the model tried.
        stats.invalid++;
        text = parsed.error; error = true;
        onEvent({kind: 'tool', id: c.id, name: c.name, input: {raw: c.arguments}});
      } else {
        const key = c.name + ' ' + JSON.stringify(parsed.args);
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        onEvent({kind: 'tool', id: c.id, name: c.name, input: parsed.args});
        if (n >= 3) {
          stats.repeats++;
          text = `You have made this exact call ${n} times and it returns the same thing. Do something different, or answer with what you have.`; error = true;
        } else {
          const verdict = await canUseTool(c.name, parsed.args, tool);
          if (!verdict.allow) { stats.denied++; text = `The person did not allow this${verdict.message ? `: ${verdict.message}` : '.'} Do not try the same thing another way; ask or continue without it.`; error = true }
          else {
            try { const r = await tool.run({...ctx, callId: c.id}, verdict.args || parsed.args); text = r.text; error = !!r.error }
            catch (e) { text = `The tool failed: ${e.message}`; error = true }
          }
        }
      }
      onEvent({kind: 'tool_result', id: c.id, text: clipFor(text), error});
      stats.actions.push({name: c.name, args: String(c.arguments || '').slice(0, 200), ok: !error, result: String(text).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 240)});
      const result = {role: 'tool', tool_call_id: c.id, content: text};
      messages.push(result);
      onMessage(result, {error});
    }
    if (shouldContinue) {
      // The judge may stop the turn, or leave a note the model reads before its next step.
      const go = await shouldContinue({messages, stats});
      if (go === false) { stats.stop = 'judged_done'; break }
      if (go && go.nudge) { stats.nudges++; messages.push({role: 'user', content: `(dec-intern: ${go.nudge})`}) }
    }
  }
  stats.ms = Date.now() - t0;
  onEvent({kind: 'result', error: stats.stop === 'error' || stats.stop === 'filtered', stop: stats.stop, turns: stats.steps, ms: stats.ms, cost: stats.cost,
    usage: {prompt: stats.prompt, completion: stats.completion, cached: stats.cached, reasoning: stats.reasoning}});
  return stats;
}
