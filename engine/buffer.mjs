// Buffer (publish.buffer.com): the channels it posts to, and a post with its own replies, through Buffer's GraphQL API.
// The key is used by name only, through dec-secret: save it in Dec as BUFFER_API_KEY for https://api.buffer.com, then
//
//   BUFFER_API_KEY=dec://BUFFER_API_KEY dec-secret run -- node engine/buffer.mjs channels
//   BUFFER_API_KEY=dec://BUFFER_API_KEY dec-secret run -- node engine/buffer.mjs post <channelId> "글" --link https://… --reply "덧글"
//
// One rule: a link never goes in the post itself (feeds show link posts less). `--link` becomes the first reply: the
// second item of a thread on X, Threads, Bluesky and Mastodon, the first comment on LinkedIn. A body with a URL in it
// is refused. Buffer takes the replies with the post, so a reply is added when the post is made, not afterwards.
//
// `post` only shows what it would send. Nothing goes to Buffer without `--send`.
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const API = (process.env.BUFFER_BASE_URL || 'https://api.buffer.com').replace(/\/+$/, '');
const THREADED = new Set(['twitter', 'threads', 'bluesky', 'mastodon']);
const COMMENTED = new Set(['linkedin']);
const MODES = {queue: 'addToQueue', next: 'shareNext', now: 'shareNow'};
const URL_RE = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]/i;

export class BufferError extends Error {}

async function gql(query, variables = {}) {
  const key = process.env.BUFFER_API_KEY;
  if (!key || /^dec:\/\//.test(key)) throw new BufferError('no Buffer key: save it in Dec as BUFFER_API_KEY (site https://api.buffer.com) and run this through `BUFFER_API_KEY=dec://BUFFER_API_KEY dec-secret run -- …`');
  const res = await fetch(API, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${key}`}, body: JSON.stringify({query, variables}), signal: AbortSignal.timeout(30e3)});
  let body = null;
  try { body = await res.json() } catch {}
  if (!res.ok || body?.errors?.length) throw new BufferError(`Buffer ${res.status}: ${body?.errors?.map(e => e.message).join('; ') || res.statusText}`);
  return body.data;
}

export async function channels() {
  const {account} = await gql('query { account { organizations { id name } } }');
  const out = [];
  for (const org of account.organizations) {
    const d = await gql('query ($org: OrganizationId!) { channels(input: { organizationId: $org }) { id name displayName service isQueuePaused } }', {org: org.id});
    for (const c of d.channels) out.push({...c, organization: org.name});
  }
  return out;
}

async function serviceOf(channelId) {
  const d = await gql('query ($id: ChannelId!) { channel(input: { id: $id }) { service } }', {id: channelId});
  return String(d.channel?.service || '').toLowerCase();
}

// The createPost input: body, then the link and any replies as the service's own replies.
export function postInput({channelId, service, text, link, replies = [], mode = 'queue', at, draft = false}) {
  text = String(text || '').trim();
  if (!channelId) throw new BufferError('which channel? (`channels` lists them)');
  if (!text) throw new BufferError('the post is empty');
  if (URL_RE.test(text)) throw new BufferError('a link in the post body: put it in --link, it goes in the first reply');
  if (link && !/^https?:\/\/\S+$/i.test(link)) throw new BufferError(`--link: "${link}" is not a URL`);
  const after = [...(link ? [link] : []), ...replies.map(r => String(r).trim()).filter(Boolean)];
  const input = {channelId, text, schedulingType: 'automatic', mode: at ? 'customScheduled' : MODES[mode] || mode, assets: []};
  if (at) { const t = new Date(at); if (isNaN(t)) throw new BufferError(`--at: "${at}" is not a date`); input.dueAt = t.toISOString() }
  if (draft) input.saveToDraft = true;
  if (after.length) {
    if (THREADED.has(service)) input.metadata = {[service]: {thread: [text, ...after].map(t => ({text: t, assets: []}))}};
    else if (COMMENTED.has(service)) {
      if (after.length > 1) throw new BufferError(`${service} takes one first comment: give either --link or one --reply`);
      input.metadata = {[service]: {firstComment: after[0]}};
    } else throw new BufferError(`${service || 'this channel'}: replies are not supported here (X, Threads, Bluesky, Mastodon, LinkedIn)`);
  }
  return input;
}

export async function post(opts) {
  const input = postInput({...opts, service: opts.service || await serviceOf(opts.channelId)});
  const d = await gql(`mutation ($input: CreatePostInput!) { createPost(input: $input) {
    ... on PostActionSuccess { post { id status dueAt } }
    ... on MutationError { message } } }`, {input});
  if (d.createPost?.message) throw new BufferError(d.createPost.message);
  return d.createPost.post;
}

// ---- command line ----
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = {replies: []}, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--reply') flags.replies.push(rest[++i]);
    else if (['--link', '--at', '--service', '--mode'].includes(a)) flags[a.slice(2)] = rest[++i];
    else if (['--send', '--draft', '--now', '--next'].includes(a)) flags[a.slice(2)] = true;
    else pos.push(a);
  }
  try {
    if (cmd === 'channels') {
      for (const c of await channels()) console.log(`${c.id}  ${c.service.padEnd(10)} ${c.displayName || c.name}${c.isQueuePaused ? '  (queue paused)' : ''}  · ${c.organization}`);
    } else if (cmd === 'post') {
      const [channelId, text] = pos;
      const opts = {channelId, text, link: flags.link, replies: flags.replies, at: flags.at, draft: !!flags.draft, service: flags.service,
        mode: flags.now ? 'now' : flags.next ? 'next' : flags.mode || 'queue'};
      if (!flags.send) {
        const keyed = process.env.BUFFER_API_KEY && !/^dec:/.test(process.env.BUFFER_API_KEY);
        const input = postInput({...opts, service: opts.service || (keyed ? await serviceOf(channelId) : 'twitter')});
        console.log(JSON.stringify(input, null, 2));
        if (!opts.service && !keyed) console.log('\n(no key, so the channel\'s service is unknown: shown as twitter; --service to pick)');
        console.log('\n(not sent: add --send to post it)');
      } else {
        const p = await post(opts);
        console.log(`posted: ${p.id} (${p.status}${p.dueAt ? `, ${new Date(p.dueAt).toLocaleString('ko-KR')}` : ''})`);
      }
    } else {
      console.log(`usage: node engine/buffer.mjs channels
       node engine/buffer.mjs post <channelId> "글" [--link URL] [--reply "덧글"]… [--now|--next|--at ISO|--draft] [--service twitter] [--send]`);
      process.exitCode = cmd ? 2 : 0;
    }
  } catch (e) {
    console.error(`buffer: ${e.message}`);
    process.exitCode = 1;
  }
}
