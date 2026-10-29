// Which key a model call goes out with, in the order the person set, and whether a key that fails hands the call to the
// next. The order is dec's: one file both apps read and write (dec's 설정 → 모델 키 순서, bisu's 설정 → 모델 키 순서):
//   ~/Library/Application Support/Dec Browser/model-routes.json  {schema:1, auto:true, order:{glm:[name…], decisions:[…], openrouter:[…]}}
// Names are the keys' dec:// names. The keys themselves come from the launcher: every saved key for OpenRouter, Z.AI and
// OpenAI as BISU_RK<n>_API_KEY (dec-secret run gives each its BISU_RK<n>_BASE_URL), listed in BISU_ROUTE_KEYS as
// "n|name|site;…". Without that list (bisu run by hand) the old variables are the keys: GLM_API_KEY (Z.AI),
// OPENROUTER_API_KEY, OPENAI_API_KEY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OR_SITE = 'https://openrouter.ai', ZAI_SITE = 'https://api.z.ai', OPENAI_SITE = 'https://api.openai.com';
export const FAMILIES = {
  glm: {label: 'GLM (비서·검토)', sites: [OR_SITE, ZAI_SITE]},
  decisions: {label: '판단 (OpenAI Decisions)', sites: [OPENAI_SITE]},
  openrouter: {label: 'OpenRouter 모델 (Claude Code)', sites: [OR_SITE]},
};
export const SITE_LABEL = {[OR_SITE]: 'OpenRouter', [ZAI_SITE]: 'Z.AI', [OPENAI_SITE]: 'OpenAI'};
const FILE = () => process.env.BISU_ROUTES_FILE || path.join(os.homedir(), 'Library', 'Application Support', 'Dec Browser', 'model-routes.json');
// A key that is out of money or refused rests ten minutes, one that was busy or down one minute. Each chat is its own
// process, so the rest is kept in a file: the next chat does not ask an empty key again.
const HEALTH = () => process.env.BISU_ROUTE_HEALTH || path.join(os.homedir(), '.config', 'bisu', 'route-health.json');
const LONG_MS = 600_000, SHORT_MS = 60_000;

// The keys this process was given, each with where its requests go (the local proxy, or the site itself).
export function keys(env = process.env) {
  const list = String(env.BISU_ROUTE_KEYS || '').split(';').map(x => x.split('|')).filter(x => x.length >= 3 && env[`BISU_RK${x[0]}_API_KEY`])
    .map(([n, name, site]) => ({name: decodeURIComponent(name), site, key: env[`BISU_RK${n}_API_KEY`], base: env[`BISU_RK${n}_BASE_URL`] || site}));
  if (list.length) return list;
  const out = [];
  if (env.OPENROUTER_API_KEY) out.push({name: 'OPENROUTER_API_KEY', site: OR_SITE, key: env.OPENROUTER_API_KEY, base: env.OPENROUTER_BASE_URL || OR_SITE});
  if (env.GLM_API_KEY) out.push({name: 'GLM_API_KEY', site: ZAI_SITE, key: env.GLM_API_KEY, base: env.GLM_BASE_URL || ZAI_SITE});
  if (env.OPENAI_API_KEY) out.push({name: 'OPENAI_API_KEY', site: OPENAI_SITE, key: env.OPENAI_API_KEY, base: (env.OPENAI_BASE_URL || OPENAI_SITE + '/v1').replace(/\/v1\/?$/, '')});
  return out;
}

export function settings() {
  let v = {};
  try { v = JSON.parse(fs.readFileSync(FILE(), 'utf8')) } catch {}
  const order = {};
  for (const f of Object.keys(FAMILIES)) order[f] = Array.isArray(v?.order?.[f]) ? v.order[f].filter(n => typeof n === 'string').slice(0, 20) : [];
  return {schema: 1, auto: v?.auto !== false, order};
}
export function save(next) {
  const cur = settings(), out = {schema: 1, auto: typeof next.auto === 'boolean' ? next.auto : cur.auto, order: {...cur.order}};
  if (next.family) {
    if (!FAMILIES[next.family] || !Array.isArray(next.order) || next.order.length > 20 || next.order.some(n => typeof n !== 'string' || !n || n.length > 120)) throw Error('bad route order');
    out.order[next.family] = next.order;
  }
  fs.mkdirSync(path.dirname(FILE()), {recursive: true});
  fs.writeFileSync(FILE(), JSON.stringify(out, null, 1), {mode: 0o600});
  return out;
}

function health() { try { return JSON.parse(fs.readFileSync(HEALTH(), 'utf8')) } catch { return {} } }
export function resting(name, now = Date.now()) { return (health()[name] || 0) > now }
export function rest(name, ms, now = Date.now()) {
  const h = health();
  for (const k of Object.keys(h)) if (h[k] <= now) delete h[k];
  if (ms > 0) h[name] = now + ms; else delete h[name];
  try { fs.mkdirSync(path.dirname(HEALTH()), {recursive: true}); fs.writeFileSync(HEALTH(), JSON.stringify(h)) } catch {}
}
export const failover = status => status === 401 || status === 402 || status === 403 || status === 429 || status >= 500;
export const restFor = (status, text = '') => status === 401 || status === 402 || status === 403 || /balance|credit|quota|insufficient|recharge|余额/i.test(String(text)) ? LONG_MS : SHORT_MS;

// This family's keys in the person's order (then, for GLM, OpenRouter before Z.AI; then as given), resting ones last.
export function routes(family, env = process.env) {
  const fam = FAMILIES[family];
  if (!fam) return [];
  const want = settings().order[family].map(n => n.toLowerCase());
  const rank = k => { const i = want.indexOf(k.name.toLowerCase()); return i < 0 ? want.length + fam.sites.indexOf(k.site) : i };
  const all = keys(env).filter(k => fam.sites.includes(k.site)).map((k, i) => ({...k, i})).sort((a, b) => rank(a) - rank(b) || a.i - b.i)
    .map(({i, ...k}) => ({...k, resting: resting(k.name)}));
  return [...all.filter(k => !k.resting), ...all.filter(k => k.resting)];
}
