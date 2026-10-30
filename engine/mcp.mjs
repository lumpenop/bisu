// A minimal MCP client over stdio, enough for Dec Intern's own server (ui/cu/server.mjs): computer use
// and past-session search. The server is started once per engine process from the same
// --mcp-config file launch.zsh already writes, and its tools are offered to the model under their
// own names (cu_look, session_search, …).
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import readline from 'node:readline';

export async function connect(configPath, {timeoutMs = 15000} = {}) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch { return null }
  const servers = cfg?.mcpServers || {};
  const tools = {};
  const procs = [];
  for (const [name, def] of Object.entries(servers)) {
    if (!def?.command) continue;
    const child = spawn(def.command, def.args || [], {env: {...process.env, ...(def.env || {})}, stdio: ['pipe', 'pipe', 'ignore']});
    procs.push(child);
    let seq = 0;
    const waiting = new Map();
    readline.createInterface({input: child.stdout}).on('line', line => {
      let j; try { j = JSON.parse(line) } catch { return }
      const w = waiting.get(j.id); if (!w) return;
      waiting.delete(j.id);
      j.error ? w.reject(new Error(j.error.message || 'MCP error')) : w.resolve(j.result);
    });
    child.on('exit', () => { for (const w of waiting.values()) w.reject(new Error(`${name} stopped`)); waiting.clear() });
    const call = (method, params, ms = timeoutMs) => new Promise((resolve, reject) => {
      const id = ++seq;
      const t = setTimeout(() => { waiting.delete(id); reject(new Error(`${name}: ${method} timed out`)) }, ms);
      waiting.set(id, {resolve: v => { clearTimeout(t); resolve(v) }, reject: e => { clearTimeout(t); reject(e) }});
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params}) + '\n');
    });
    try {
      await call('initialize', {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'dec-intern-engine', version: '1'}});
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', method: 'notifications/initialized'}) + '\n');
      const {tools: list = []} = await call('tools/list', {});
      for (const t of list) {
        tools[t.name] = {
          description: t.description, parameters: t.inputSchema || {type: 'object', properties: {}},
          // Computer use acts on other apps; the rest only reads.
          kind: /^cu_(click|type|key|scroll|approve)$/.test(t.name) ? 'mac' : 'read', mcp: name,
          async run(ctx, args) {
            const r = await call('tools/call', {name: t.name, arguments: args}, 120000);
            const text = (r?.content || []).map(b => b.type === 'text' ? b.text : `[${b.type}]`).join('\n');
            return {text: text || '(no output)', error: !!r?.isError};
          },
        };
      }
    } catch { try { child.kill() } catch {} }
  }
  return {tools, close: () => { for (const p of procs) try { p.kill() } catch {} }};
}
