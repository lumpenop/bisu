// The tools bisu's own engine gives the model: files, search, the shell and the web.
//
// Each tool is a JSON schema (what the model sees) and a function (what runs). They all take a
// context — the chat's folder, the files read so far, an abort signal — and return text for the
// model; a failure is returned as text too, marked as an error, so the model can correct itself
// instead of the turn dying.
//
// Edits follow the rule that keeps an agent honest: a file must be read before it is changed, and
// an edit names the exact text it replaces, once.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import * as keys from './keys.mjs';

const MAX_OUT = 30_000;
// What a command the model runs may see of the engine's environment. Not the API tokens or base
// URLs the engine itself was given — a shell command has no business with them.
const SAFE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'];
export const commandEnv = extra => ({...Object.fromEntries(SAFE_ENV.filter(k => process.env[k]).map(k => [k, process.env[k]])), ...extra});
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store', '.next', 'dist', 'build', '.venv', '__pycache__', '.cache']);

const expand = p => String(p || '').replace(/^~(?=\/|$)/, os.homedir());
export const resolvePath = (ctx, p) => path.resolve(ctx.cwd, expand(p));
const rel = (ctx, abs) => { const r = path.relative(ctx.cwd, abs); return r && !r.startsWith('..') ? r : abs };
export const insideCwd = (ctx, abs) => abs === ctx.cwd || abs.startsWith(ctx.cwd + path.sep);

function clip(s, max = MAX_OUT) {
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.6)), tail = s.slice(-Math.floor(max * 0.35));
  return `${head}\n… (${s.length - head.length - tail.length} characters cut) …\n${tail}`;
}
const isBinary = buf => { const n = Math.min(buf.length, 8000); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false };

// ---- glob ----
export function globToRegExp(glob) {
  let re = '', i = 0;
  const g = String(glob);
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3 } else { re += '.*'; i += 2 } }
      else { re += '[^/]*'; i++ }
    } else if (c === '?') { re += '[^/]'; i++ }
    else if (c === '{') { const end = g.indexOf('}', i); if (end < 0) { re += '\\{'; i++; continue } re += '(?:' + g.slice(i + 1, end).split(',').map(s => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = end + 1 }
    else { re += c.replace(/[.+^$()|[\]\\]/g, '\\$&'); i++ }
  }
  return new RegExp('^' + re + '$');
}
function* walk(dir, base = dir, budget = {n: 20000}) {
  let entries = [];
  try { entries = fs.readdirSync(dir, {withFileTypes: true}) } catch { return }
  for (const e of entries) {
    if (budget.n-- <= 0) return;
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, base, budget);
    else if (e.isFile()) yield p;
  }
}

// ---- the tools ----
export const TOOLS = {
  read_file: {
    description: 'Read a text file. Returns numbered lines ("12\\tcode"). Use offset/limit for long files. Read a file before editing or overwriting it.',
    parameters: {type: 'object', properties: {
      path: {type: 'string', description: 'file path, relative to the working folder or absolute'},
      offset: {type: 'integer', description: 'first line to read, 1-based (default 1)'},
      limit: {type: 'integer', description: 'how many lines (default 2000)'},
    }, required: ['path']},
    kind: 'read',
    run(ctx, {path: p, offset = 1, limit = 2000}) {
      const abs = resolvePath(ctx, p);
      const st = fs.statSync(abs, {throwIfNoEntry: false});
      if (!st) return err(`No such file: ${rel(ctx, abs)}`);
      if (st.isDirectory()) return err(`${rel(ctx, abs)} is a folder; use list_files.`);
      if (st.size > 8 << 20) return err(`${rel(ctx, abs)} is ${Math.round(st.size / 1048576)} MB; use search_files to find what you need in it.`);
      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) return err(`${rel(ctx, abs)} is a binary file.`);
      ctx.readFiles.add(abs);
      const lines = buf.toString('utf8').split('\n');
      const from = Math.max(1, offset | 0 || 1), n = Math.max(1, Math.min(5000, limit | 0 || 2000));
      const out = lines.slice(from - 1, from - 1 + n).map((l, i) => `${from + i}\t${l.length > 2000 ? l.slice(0, 2000) + '…' : l}`);
      const more = lines.length - (from - 1 + out.length);
      return ok((out.join('\n') || '(empty file)') + (more > 0 ? `\n… ${more} more lines; continue with offset ${from + out.length}.` : ''));
    },
  },
  write_file: {
    description: 'Create a file, or replace a whole file you have already read. Prefer edit_file for changes to an existing file.',
    parameters: {type: 'object', properties: {
      path: {type: 'string'},
      content: {type: 'string', description: 'the complete new contents'},
    }, required: ['path', 'content']},
    kind: 'write',
    run(ctx, {path: p, content}) {
      const abs = resolvePath(ctx, p);
      const st = fs.statSync(abs, {throwIfNoEntry: false});
      if (st?.isDirectory()) return err(`${rel(ctx, abs)} is a folder.`);
      if (st && !ctx.readFiles.has(abs)) return err(`${rel(ctx, abs)} already exists. Read it with read_file first, then overwrite it or use edit_file.`);
      fs.mkdirSync(path.dirname(abs), {recursive: true});
      fs.writeFileSync(abs, String(content ?? ''));
      ctx.readFiles.add(abs);
      return ok(`${st ? 'Replaced' : 'Created'} ${rel(ctx, abs)} (${String(content ?? '').split('\n').length} lines).`);
    },
  },
  edit_file: {
    description: 'Replace exact text in a file you have read. old_string must match the file exactly (including indentation) and be unique, unless replace_all is true. To insert, include a nearby unique line in old_string and repeat it in new_string.',
    parameters: {type: 'object', properties: {
      path: {type: 'string'},
      old_string: {type: 'string'},
      new_string: {type: 'string'},
      replace_all: {type: 'boolean', description: 'replace every occurrence (default false)'},
    }, required: ['path', 'old_string', 'new_string']},
    kind: 'write',
    run(ctx, {path: p, old_string: a, new_string: b, replace_all = false}) {
      const abs = resolvePath(ctx, p);
      if (!fs.existsSync(abs)) return err(`No such file: ${rel(ctx, abs)}. Use write_file to create it.`);
      if (!ctx.readFiles.has(abs)) return err(`Read ${rel(ctx, abs)} with read_file before editing it.`);
      if (typeof a !== 'string' || !a.length) return err('old_string is empty; give the exact text to replace.');
      if (a === b) return err('old_string and new_string are the same; nothing to change.');
      const text = fs.readFileSync(abs, 'utf8');
      const count = text.split(a).length - 1;
      if (!count) {
        // The usual miss is whitespace: say where a trimmed version would have matched.
        const hint = a.trim() && text.includes(a.trim()) ? ' The text exists with different surrounding whitespace; copy it exactly from read_file output (without the line-number prefix).' : ' Read the file again and copy the text exactly.';
        return err(`old_string was not found in ${rel(ctx, abs)}.${hint}`);
      }
      if (count > 1 && !replace_all) return err(`old_string appears ${count} times in ${rel(ctx, abs)}. Include more surrounding lines to make it unique, or set replace_all.`);
      const next = replace_all ? text.split(a).join(b) : text.replace(a, () => b);
      fs.writeFileSync(abs, next);
      const at = next.slice(0, next.indexOf(b)).split('\n').length;
      const lines = next.split('\n');
      const from = Math.max(1, at - 2), to = Math.min(lines.length, at + b.split('\n').length + 1);
      return ok(`Edited ${rel(ctx, abs)}${replace_all && count > 1 ? ` (${count} places)` : ''}:\n` + lines.slice(from - 1, to).map((l, i) => `${from + i}\t${l}`).join('\n'));
    },
  },
  list_files: {
    description: 'Find files by glob pattern, newest first, e.g. "**/*.mjs" or "src/*.ts". Skips .git and node_modules.',
    parameters: {type: 'object', properties: {
      pattern: {type: 'string'},
      path: {type: 'string', description: 'folder to search in (default: the working folder)'},
    }, required: ['pattern']},
    kind: 'read',
    run(ctx, {pattern, path: p}) {
      const base = resolvePath(ctx, p || '.');
      if (!fs.statSync(base, {throwIfNoEntry: false})?.isDirectory()) return err(`No such folder: ${rel(ctx, base)}`);
      const re = globToRegExp(pattern || '**/*');
      const hits = [];
      for (const f of walk(base)) if (re.test(path.relative(base, f))) { let m = 0; try { m = fs.statSync(f).mtimeMs } catch {} hits.push([f, m]) }
      hits.sort((x, y) => y[1] - x[1]);
      if (!hits.length) return ok(`No files match ${pattern}.`);
      return ok(hits.slice(0, 200).map(([f]) => rel(ctx, f)).join('\n') + (hits.length > 200 ? `\n… ${hits.length - 200} more` : ''));
    },
  },
  search_files: {
    description: 'Search file contents with a regular expression (JavaScript syntax). Returns "path:line: text" for each match, or only file names with files_only.',
    parameters: {type: 'object', properties: {
      pattern: {type: 'string', description: 'regular expression'},
      path: {type: 'string', description: 'file or folder (default: the working folder)'},
      glob: {type: 'string', description: 'only files matching this glob, e.g. "**/*.ts"'},
      ignore_case: {type: 'boolean'},
      files_only: {type: 'boolean', description: 'list matching files instead of lines'},
    }, required: ['pattern']},
    kind: 'read',
    run(ctx, {pattern, path: p, glob, ignore_case = false, files_only = false}) {
      let re;
      try { re = new RegExp(pattern, ignore_case ? 'i' : '') } catch (e) { return err(`Invalid regular expression: ${e.message}`) }
      const base = resolvePath(ctx, p || '.');
      const st = fs.statSync(base, {throwIfNoEntry: false});
      if (!st) return err(`No such path: ${rel(ctx, base)}`);
      const gre = glob ? globToRegExp(glob) : null;
      const files = st.isDirectory() ? walk(base) : [base];
      const out = [], matchedFiles = [];
      let total = 0;
      for (const f of files) {
        if (gre && !gre.test(st.isDirectory() ? path.relative(base, f) : path.basename(f))) continue;
        let buf;
        try { if (fs.statSync(f).size > 4 << 20) continue; buf = fs.readFileSync(f) } catch { continue }
        if (isBinary(buf)) continue;
        const lines = buf.toString('utf8').split('\n');
        let hit = false;
        lines.forEach((l, i) => { if (re.test(l)) { total++; hit = true; if (!files_only && out.length < 300) out.push(`${rel(ctx, f)}:${i + 1}: ${l.length > 300 ? l.slice(0, 300) + '…' : l}`) } });
        if (hit) matchedFiles.push(rel(ctx, f));
      }
      if (!total) return ok(`No matches for /${pattern}/.`);
      if (files_only) return ok(`${matchedFiles.length} files, ${total} matching lines:\n` + matchedFiles.join('\n'));
      return ok(`${total} matching lines in ${matchedFiles.length} files${total > out.length ? ` (first ${out.length} shown)` : ''}:\n` + out.join('\n'));
    },
  },
  run_command: {
    description: 'Run a shell command (zsh) in the working folder and return its output and exit code. For builds, tests, git, and scripts. Avoid interactive commands. When the command needs one of the person\'s API keys (a project that reads OPENAI_API_KEY, a call to an API with their key), name the keys in `keys` (secret_list shows them): the command then gets a one-time token in that variable and the service\'s address in <PREFIX>_BASE_URL (OPENAI_BASE_URL …), and must send its requests to that base url. Never read, print or ask for a key.',
    parameters: {type: 'object', properties: {
      command: {type: 'string'},
      timeout_seconds: {type: 'integer', description: 'default 120, at most 600'},
      keys: {type: 'array', items: {type: 'string'}, description: 'variable names of keys saved in Dec to provide, e.g. ["OPENAI_API_KEY"]'},
    }, required: ['command']},
    kind: 'exec',
    async run(ctx, {command, timeout_seconds = 120, keys: names = []}) {
      // The keys stay in Dec: dec-secret starts the command with a one-time token per key (engine/keys.mjs).
      let file = '/bin/zsh', args = ['-c', String(command)], withKeys = {};
      if (Array.isArray(names) && names.length) {
        const w = await keys.wrap(command, names.map(String));
        if (w.error) return err(w.error);
        ({file, args, env: withKeys} = w);
      }
      return new Promise(resolve => {
        const env = commandEnv({...ctx.env, PAGER: 'cat', GIT_PAGER: 'cat', TERM: 'dumb', NO_COLOR: '1', ...withKeys});
        const child = spawn(file, args, {cwd: ctx.cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
        let out = '';
        const add = d => { out += d; if (out.length > MAX_OUT * 4) out = out.slice(-MAX_OUT * 2) };
        child.stdout.on('data', add); child.stderr.on('data', add);
        const ms = Math.min(600, Math.max(1, timeout_seconds | 0 || 120)) * 1000;
        let killed = '';
        const t = setTimeout(() => { killed = `timed out after ${ms / 1000}s`; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 2000) }, ms);
        const stop = () => { killed = 'stopped'; child.kill('SIGTERM') };
        ctx.signal?.addEventListener('abort', stop, {once: true});
        child.on('error', e => { clearTimeout(t); resolve(err(`Could not run: ${e.message}`)) });
        child.on('close', code => {
          clearTimeout(t); ctx.signal?.removeEventListener('abort', stop);
          // A one-time token printed by the command (`env`, a debug line) is worth nothing after it, and still not the model's.
          const body = clip(out.trimEnd().replace(/dec-use-only-[A-Za-z0-9._-]+/g, '[dec token]')) || '(no output)';
          resolve(killed ? err(`${killed}\n${body}`) : code ? {text: `exit ${code}\n${body}`, error: true} : ok(body));
        });
      });
    },
  },
  web_fetch: {
    description: 'Fetch a web page or JSON and return its readable text.',
    parameters: {type: 'object', properties: {url: {type: 'string'}}, required: ['url']},
    kind: 'net',
    async run(ctx, {url}) {
      let u;
      try { u = new URL(url) } catch { return err('Not a valid URL.') }
      if (!/^https?:$/.test(u.protocol)) return err('Only http and https URLs.');
      const r = await fetch(u, {redirect: 'follow', signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(ctx.signal ? [ctx.signal] : [])]), headers: {'user-agent': 'bisu/1.0', accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5'}});
      const type = r.headers.get('content-type') || '';
      const body = await r.text();
      const text = /html/.test(type) ? htmlText(body) : body;
      return {text: `${r.status} ${r.url}\n\n${clip(text, 20_000)}`, error: !r.ok};
    },
  },
};

function htmlText(html) {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const ok = text => ({text});
const err = text => ({text, error: true});

// The definitions in the OpenAI-compatible "tools" format.
export function toolSpecs(names = Object.keys(TOOLS), extra = {}) {
  const all = {...TOOLS, ...extra};
  return names.filter(n => all[n]).map(n => ({type: 'function', function: {name: n, description: all[n].description, parameters: all[n].parameters}}));
}

// Parse and check arguments before running: a malformed call comes back to the model as an error it
// can fix, and is counted (that count is one of the things the benchmark measures).
export function parseArgs(tool, raw) {
  let args;
  try { args = raw && raw.trim() ? JSON.parse(raw) : {} } catch (e) { return {error: `The arguments were not valid JSON (${e.message}). Send them again as one JSON object.`} }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {error: 'The arguments must be a JSON object.'};
  const missing = (tool.parameters.required || []).filter(k => args[k] === undefined || args[k] === null);
  if (missing.length) return {error: `Missing required argument${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`};
  return {args};
}
