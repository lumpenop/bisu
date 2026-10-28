#!/usr/bin/env node
// bisu ui — one local page to talk to bisu, approve what it does, pick models per role, and check the key and real spend.
// Started by `bisu ui`. Listens on 127.0.0.1 only; no dependencies.
//  * Chat: each conversation is a real headless Claude Code run started through launch.zsh (same env, models, tools, prompt
//    and agents as `bisu`), speaking stream-json. The process starts when the chat is created or opened and stays up between messages; after IDLE_MS without activity it
//    stops; opening the chat or the next message resumes it with --resume. Tool use that needs permission comes back as a can_use_tool
//    request and waits for the person to allow or deny it on the page.
//  * Key: the same one bisu uses. In use-only mode (dec-secret run) this process and every chat hold a one-time token and a
//    local OPENROUTER_BASE_URL, never the key itself. Adding or changing the key happens in Dec, not here.
//  * Models: saved to ~/.config/bisu/models as plain KEY=value lines; bisu.zsh reads them (exported BISU_* still win).
//  * History: bisu's Claude Code transcripts in ~/.claude/projects, told apart from your subscription sessions by their
//    OpenRouter model slugs (provider/model). Cost is an estimate from OpenRouter list prices.
//  * Every API call carries a per-launch token that only this page knows; other hosts and cross-site origins are refused.
import http from 'node:http';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFile,spawn} from 'node:child_process';import {randomBytes,randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
import * as memory from './memory.mjs';
import * as bots from './bots.mjs';
import * as routines from './routines.mjs';
import * as proactive from './proactive.mjs';
import * as sessions from './sessions.mjs';
import * as jobs from './jobs.mjs';
import * as briefing from './briefing.mjs';
import * as cubench from './cubench.mjs';
import * as telegram from './telegram.mjs';
import * as alerts from './alerts.mjs';
import * as goals from './goals.mjs';
import * as webwaits from './webwaits.mjs';
import {releaseSchedule,holdsSchedule} from './lock.mjs';
import {PRICES as GLM_PRICES} from '../engine/glm.mjs';
import {eventKit} from '../engine/calendar.mjs';

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(here);
const PORT=Number(process.env.BISU_UI_PORT||7878);
// The desktop shell (mac/) starts this engine itself and needs to read /api/chats for the tray
// and its approval notifications, so it may pass its own token. Without it, a fresh one each run.
const TOKEN=/^[0-9a-f]{32,64}$/.test(process.env.BISU_UI_TOKEN||'')?process.env.BISU_UI_TOKEN:randomBytes(24).toString('hex');
const PARENT=process.env.BISU_UI_PARENT||'';
// Read once and gone: every chat, job and suggestion run inherits this process's environment, and a
// command an agent runs must not find the token that approves its own requests on this page.
for(const k of ['BISU_UI_TOKEN','BISU_UI_PORT','BISU_UI_PARENT'])delete process.env[k];
// The engine is every chat at once: one stray exception must cost one request, not all of them.
process.on('uncaughtException',e=>console.error('bisu engine: uncaught',e?.stack||e));
process.on('unhandledRejection',e=>console.error('bisu engine: unhandled rejection',e?.stack||e));
// What the menu bar app appends to a message (<bisu-context>…) is for the model, never a title.
const cleanTitle=t=>String(t||'').replace(/<bisu-context>[\s\S]*?(<\/bisu-context>|$)/g,' ').replace(/\s+/g,' ').trim().slice(0,60)||null;
const CONFIG=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'bisu','models');
// The chats themselves live in memory (each one owns a Claude Code process), but their names and
// session ids are written down: the engine is restarted with the shell, and the panel must come back
// with the conversations it had instead of an empty page.
const CHATS_FILE=path.join(path.dirname(CONFIG),'chats.json');
// Transcripts: Claude Code's, and those of bisu's own engine (engine/store.mjs).
const PROJECTS=path.join(os.homedir(),'.claude','projects');
const NATIVE_SESSIONS=process.env.BISU_SESSIONS_DIR||path.join(os.homedir(),'Library','Application Support','bisu','sessions');
const TRANSCRIPT_DIRS=`${PROJECTS}:${NATIVE_SESSIONS}`;
const HELPER=path.join(os.homedir(),'Library','Application Support','Dec Browser','bin','dec-secret-helper');
const ROLES={BISU_MODEL:'z-ai/glm-5.3',BISU_DEV_MODEL:'deepseek/deepseek-v4.1-flash',BISU_CODE_MODEL:'qwen/qwen3.8-max-0902'};
// Old names still read from the config file and the environment.
const ALIAS={BISU_FAST_MODEL:'BISU_DEV_MODEL'};
const SLUG=/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:-]+$/;
const KEY=process.env.OPENROUTER_API_KEY||'';
const KEY_BASE=(process.env.OPENROUTER_BASE_URL||'https://openrouter.ai').replace(/\/$/,'');
const keyMode=!KEY?'none':KEY.startsWith('dec-use-only-')?'use-only':'plain';
// The key the chosen engine thinks with: OpenRouter for Claude Code, Z.ai for bisu's own engine.
const canThink=()=>process.env.BISU_ENGINE==='native'?!!process.env.GLM_API_KEY:!!KEY;
const noKey=()=>process.env.BISU_ENGINE==='native'?'No Z.ai key: save one for https://api.z.ai in Dec first.':'No OpenRouter key: save one for https://openrouter.ai in Dec first.';

// ---- models config ----
function readConfig(){const out={};try{for(const line of fs.readFileSync(CONFIG,'utf8').split('\n')){const m=/^(BISU_[A-Z_]+)=(\S+)$/.exec(line.trim());const k=m&&(ALIAS[m[1]]||m[1]);if(k in ROLES&&SLUG.test(m[2])&&!(k in out&&ALIAS[m[1]]))out[k]=m[2]}}catch{}return out}
function writeConfig(models){fs.mkdirSync(path.dirname(CONFIG),{recursive:true});const tmp=CONFIG+'.tmp';
 fs.writeFileSync(tmp,'# bisu models, written by `bisu ui`. Exported BISU_* variables override these.\n'+Object.keys(ROLES).filter(k=>models[k]).map(k=>`${k}=${models[k]}`).join('\n')+'\n');fs.renameSync(tmp,CONFIG)}
const envOf=k=>process.env[k]||Object.keys(ALIAS).filter(a=>ALIAS[a]===k).map(a=>process.env[a]).find(Boolean)||null;
function roles(){const saved=readConfig();return Object.fromEntries(Object.entries(ROLES).map(([k,d])=>[k,{value:envOf(k)||saved[k]||d,saved:saved[k]||null,default:d,env:envOf(k)}]))}

// ---- page preferences ----
const PREFS=path.join(path.dirname(CONFIG),'ui.json');
// engine: 'claude' (Claude Code over OpenRouter) or 'native' (bisu's own engine on Z.ai GLM). It is
// put in this process's environment, so every chat, job and suggestion started after a change uses it.
const PREF_KEYS={meta:['boolean',false],onboarded:['boolean',false],engine:[['claude','native'],'claude'],approve:[['risky','always'],'risky']};
const prefOk=(t,v)=>Array.isArray(t)?t.includes(v):typeof v===t;
function savedPrefs(){let p={};try{p=JSON.parse(fs.readFileSync(PREFS,'utf8'))||{}}catch{}
 return Object.fromEntries(Object.entries(PREF_KEYS).map(([k,[t,d]])=>[k,prefOk(t,p[k])?p[k]:d]))}
function readPrefs(){const out=savedPrefs(),forced=process.env.BISU_ENGINE_FORCED||null;
 if(forced)out.engine=forced;
 return {...out,engineForced:!!forced,glm:!!process.env.GLM_API_KEY,decisions:!!process.env.OPENAI_API_KEY}}
// Saved on top of what was saved, not of what is shown: an engine forced from the shell for one run
// must not become the saved choice the moment any other setting changes.
function writePrefs(patch){const next=savedPrefs();for(const [k,[t]] of Object.entries(PREF_KEYS))if(prefOk(t,patch?.[k]))next[k]=patch[k];
 fs.mkdirSync(path.dirname(PREFS),{recursive:true});const tmp=PREFS+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(next));fs.renameSync(tmp,PREFS);
 applyEngine();return readPrefs()}
// An engine set from the shell (BISU_ENGINE=native bisu ui) wins over the saved choice.
if(process.env.BISU_ENGINE)process.env.BISU_ENGINE_FORCED=process.env.BISU_ENGINE;
function applyEngine(){const p=readPrefs();process.env.BISU_ENGINE=p.engine;process.env.BISU_APPROVE=p.approve}
applyEngine();

// ---- OpenRouter ----
let modelCache={at:0,list:null};
async function models(){if(modelCache.list&&Date.now()-modelCache.at<10*60e3)return modelCache.list;
 const r=await fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('models '+r.status);
 const list=(await r.json()).data.map(m=>({id:m.id,name:m.name,context:m.context_length,tools:(m.supported_parameters||[]).includes('tools'),
  prompt:Number(m.pricing?.prompt)||0,completion:Number(m.pricing?.completion)||0,cacheRead:Number(m.pricing?.input_cache_read)||0}));
 modelCache={at:Date.now(),list};return list}
async function priceMap(){try{return new Map((await models()).map(m=>[m.id,m]))}catch{return new Map()}}
// The prices on hand, now: a turn's end must not wait up to 15 s for OpenRouter's model list (the
// chat stayed "busy" meanwhile, and two turns could settle out of order). A stale or missing list is
// refreshed in the background, and a failure is not retried for a minute.
let priceFailedAt=0;
function priceNow(){
 if(modelCache.list){if(Date.now()-modelCache.at>10*60e3)models().catch(()=>{});return new Map(modelCache.list.map(m=>[m.id,m]))}
 if(Date.now()-priceFailedAt>60e3)models().catch(()=>{priceFailedAt=Date.now()});
 return new Map()}
// usage: {model: {input, cacheRead, output}} -> USD at OpenRouter list prices, or null when a model has no price.
function estimate(usage,price){let cost=0;for(const [id,u] of Object.entries(usage)){const pr=price.get(id);if(!pr)return null;cost+=u.input*pr.prompt+u.cacheRead*(pr.cacheRead||pr.prompt)+u.output*pr.completion}return cost}
async function keyGet(p){const r=await fetch(KEY_BASE+p,{headers:{authorization:'Bearer '+KEY},signal:AbortSignal.timeout(30000)});const j=await r.json().catch(()=>null);if(!r.ok)throw Error((j?.error?.message||j?.error||'HTTP')+' '+r.status);return j?.data}
// Whether the installed dec-secret-helper streams answers (`stream`) or buffers them (older helper, ~200 s per request).
function helperStreams(){return new Promise(resolve=>{if(keyMode!=='use-only')return resolve(null);
 const c=execFile(HELPER,['stream'],{encoding:'utf8',timeout:5000},(e,out)=>{let j=null;try{j=JSON.parse(out)}catch{}resolve(j?.code==='INPUT_INVALID'?true:/^USAGE/.test(j?.code||'')?false:null)});c.on('error',()=>resolve(null));c.stdin.end('')})}
// ---- bisu's own engine: its keys, what it spent, its models, the calendar ----
const keyState=v=>!v?'none':v.startsWith('dec-use-only-')?'use-only':'plain';
// What it spent, from its own transcripts at Z.ai's prices (Z.ai has no account page to ask). Only
// the files touched this month are read.
function nativeSpend(){
 const now=new Date(),day0=new Date(now.getFullYear(),now.getMonth(),now.getDate()),week0=new Date(+day0-((day0.getDay()+6)%7)*864e5),month0=new Date(now.getFullYear(),now.getMonth(),1);
 const out={today:0,week:0,month:0,turns:0};
 let dirs=[];try{dirs=fs.readdirSync(NATIVE_SESSIONS,{withFileTypes:true}).filter(d=>d.isDirectory())}catch{return out}
 for(const d of dirs)for(const f of fs.readdirSync(path.join(NATIVE_SESSIONS,d.name)).filter(f=>f.endsWith('.jsonl'))){
  const file=path.join(NATIVE_SESSIONS,d.name,f);if(fs.statSync(file).mtime<month0)continue;
  for(const line of fs.readFileSync(file,'utf8').split('\n')){if(!line.includes('"usage"'))continue;let j;try{j=JSON.parse(line)}catch{continue}
   const u=j.message?.usage,price=GLM_PRICES[String(j.message?.model||'').replace(/^z-ai\//,'')],at=new Date(j.timestamp);
   if(j.type!=='assistant'||!u||!price||!(at>=month0))continue;
   const cost=((u.input_tokens||0)*price.input+(u.cache_read_input_tokens||0)*price.cached+(u.output_tokens||0)*price.output)/1e6;
   out.month+=cost;if(at>=week0)out.week+=cost;if(at>=day0)out.today+=cost;out.turns++}}
 return out}
// The helper answers for whoever started it, which here is bisu itself.
async function calendarAccess(op='status'){const ek=eventKit();
 try{return await (op==='request'?ek.request():ek.status())}catch(e){return /not installed/.test(e.message)?{missing:true}:{error:e.message}}}
async function nativeInfo(){return {glm:keyState(process.env.GLM_API_KEY||''),decisions:keyState(process.env.OPENAI_API_KEY||''),
 models:{assistant:process.env.BISU_NATIVE_MODEL||'glm-5.3',worker:process.env.BISU_NATIVE_WORK_MODEL||'glm-5.3-flash'},spend:nativeSpend(),calendar:await calendarAccess()}}
async function account(){
 const streams=await helperStreams();if(!KEY)return {mode:keyMode,streams};
 const [key,credits]=await Promise.allSettled([keyGet('/api/v1/key'),keyGet('/api/v1/credits')]);
 const k=key.status==='fulfilled'?key.value:null;
 return {mode:keyMode,streams,key:k&&{label:k.label,limit:k.limit,limit_remaining:k.limit_remaining,usage_daily:k.usage_daily,usage_weekly:k.usage_weekly,usage_monthly:k.usage_monthly},
  keyError:key.status==='rejected'?key.reason.message:null,credits:credits.status==='fulfilled'?credits.value:null,creditsError:credits.status==='rejected'?credits.reason.message:null}}

// ---- history ----
// The transcripts are parsed in ui/history.mjs, a process that exits when it is done: a cold pass
// over ~200MB of JSON grows V8 by a few hundred megabytes and never gives them back. This process
// only asks for the result and keeps it while no transcript has changed.
const SCAN=path.join(here,'history.mjs');
const HISTORY_DAYS=60;
function* jsonlFiles(dir,depth=0){let ents=[];try{ents=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
 for(const e of ents){const p=path.join(dir,e.name);if(e.isDirectory()&&depth<3&&e.name!=='memory')yield* jsonlFiles(p,depth+1);else if(e.isFile()&&e.name.endsWith('.jsonl'))yield p}}
// Cheap enough (a few hundred stat calls) to answer "is the cached list still current?" on every open.
function newestTranscript(){let newest=0;for(const p of [...jsonlFiles(PROJECTS),...jsonlFiles(NATIVE_SESSIONS)]){try{const m=fs.statSync(p).mtimeMs;if(m>newest)newest=m}catch{}}
 return newest}
function scanHistory(mode,arg){return new Promise((resolve,reject)=>{
 // A stripped environment: the reader needs nothing from this process, and the key tokens in it
 // should not be handed to a program whose only job is reading files.
 const env={PATH:process.env.PATH||'/usr/bin:/bin',HOME:os.homedir()};
 execFile(process.execPath,[SCAN,mode,TRANSCRIPT_DIRS,String(HISTORY_DAYS),arg],{encoding:'utf8',env,timeout:120000,maxBuffer:32<<20},(err,out,errOut)=>{
  if(err)return reject(Error(`history ${mode} failed: ${(errOut||err.message).trim().split('\n').pop()}`));
  try{resolve(JSON.parse(out))}catch{reject(Error(`history ${mode} printed no json`))}})})}

let history={at:0,list:null,pending:null};
function runs(){
 const newest=newestTranscript();
 if(history.list&&history.at>=newest)return Promise.resolve(history.list);
 if(history.pending)return history.pending;
 // Stamped before the scan, so a transcript written while it runs counts as newer next time.
 const started=Date.now();
 const p=(async()=>{
  try{
   const {sessions}=await scanHistory('runs',SLUG.source);
   const price=await priceMap();
   const list=sessions.map(s=>({...s,cost:estimate(s.usage,price)}));
   history={at:started,list};
   return list;
  }catch(e){
   console.error('bisu history:',e.message);
   if(history.list)return history.list;
   throw e;
  }finally{history.pending=null}
 })();
 history.pending=p;
 return p}
// The visible conversation of a past session, for showing it again when it is resumed.
async function pastMessages(sessionId){return (await scanHistory('session',sessionId)).messages}

// ---- chats that outlive the engine ----
// Only what is needed to find a conversation again: Claude Code's own transcript is the conversation,
// so a restored chat replays it from there instead of keeping a second copy here.
function saveChats(){
 try{
  // A chat that never got a session has no conversation to come back to; the next panel open
  // should offer a folder instead of an empty one.
  const list=[...chats.values()].filter(c=>c.sessionId).sort((a,b)=>b.created-a.created).slice(0,30)
   .map(c=>({id:c.id,cwd:c.cwd,title:c.title,sessionId:c.sessionId,created:c.created,lastAt:c.lastAt||c.created,bot:c.bot||bots.DEFAULT,...(c.maker?{maker:true}:{})}));
  fs.mkdirSync(path.dirname(CHATS_FILE),{recursive:true});
  const tmp=CHATS_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(list));fs.renameSync(tmp,CHATS_FILE);
 }catch(e){console.error('bisu chats: cannot save:',e.message)}
}
function restoreChats(){
 let list=[];try{list=JSON.parse(fs.readFileSync(CHATS_FILE,'utf8'))}catch{return}
 if(!Array.isArray(list))return;
 for(const saved of list.slice(0,30)){
  const id=saved?.id,cwd=saved?.cwd;
  if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))continue;
  if(typeof cwd!=='string'||!fs.statSync(cwd,{throwIfNoEntry:false})?.isDirectory())continue;
  if(chats.has(id))continue;
  const sessionId=typeof saved.sessionId==='string'&&/^[0-9a-f-]{36}$/.test(saved.sessionId)?saved.sessionId:null;
  chats.set(id,{id,cwd,title:typeof saved.title==='string'?cleanTitle(saved.title):null,busy:false,proc:null,sessionId,
   events:[],clients:new Set(),pending:new Map(),allowTools:new Set(),tasks:new Map(),queued:[],turnsDone:0,costSoFar:0,
   created:Number(saved.created)||Date.now(),lastAt:Number(saved.lastAt)||Number(saved.created)||Date.now(),
   // Chats from before bots belong to the default bot.
   bot:bots.validId(saved.bot)?saved.bot:bots.DEFAULT,maker:saved.maker===true});
 }
}

// ---- chats ----
// One Claude Code process per chat. Events are kept (capped) so a reloaded page can replay the conversation.
const chats=new Map();
restoreChats();
const MAX_EVENTS=3000;
// A chat's process is started as soon as the chat is created or opened, so the first message doesn't wait for Claude Code
// to boot. It stays up between messages while the page is watching it, and is stopped after IDLE_MS without activity.
const IDLE_MS=Number(process.env.BISU_UI_IDLE_MIN||30)*60e3;
// Claude Code is by far the largest part of bisu's memory (a few hundred MB), so a chat nobody is looking at should not
// keep it alive. The panel detaches its event stream when it hides, which lands here: nothing is watching, nothing is
// running, so let go after this grace instead of waiting out the full IDLE_MS. Reopening starts it again.
const PARK_MS=Number(process.env.BISU_UI_PARK_SEC||60)*1e3;
function reap(c){
 if(!c.proc||c.busy||c.pending.size||c.tasks?.size)return;
 // SIGTERM only: a half-written turn should still be able to flush.
 try{c.proc.kill('SIGTERM')}catch{}
}
function idleLater(c){
 clearTimeout(c.idle);
 // Watched: keep it warm between messages. Unwatched: a much shorter grace, because the process is pure idle cost then.
 c.idle=setTimeout(()=>reap(c),c.clients.size?IDLE_MS:PARK_MS);
}
function unwatched(c){clearTimeout(c.idle);if(c.proc&&!c.busy&&!c.pending.size&&!c.tasks?.size)idleLater(c)}
// lastAt is the last time the person or bisu actually said something, which is what decides whether
// the panel picks a conversation up again or starts fresh.
function publicChat(c){return {id:c.id,bot:c.bot||bots.DEFAULT,maker:!!c.maker,cwd:c.cwd,title:c.title,busy:c.busy,alive:!!c.proc,sessionId:c.sessionId,pending:c.pending.size,tasks:c.tasks?.size||0,queued:c.queued?.length||0,created:c.created,lastAt:c.lastAt||c.created}}
// A restored chat has no events until it is opened; its transcript is replayed into the stream then.
async function hydrate(c){
 if(c.events.length||!c.sessionId)return;
 if(c.hydrating)return c.hydrating;
 c.hydrating=(async()=>{try{
  const past=await pastMessages(c.sessionId);
  if(!past.length||c.events.length)return;
  push(c,{kind:'resumed',sessionId:c.sessionId,count:past.length});
  for(const m of past)push(c,{...m,past:true});
  if(!c.title){const first=past.find(m=>m.kind==='user');if(first)c.title=cleanTitle(first.text);saveChats()}
 }catch(e){console.error('bisu resume:',e.message)}finally{c.hydrating=null}})();
 return c.hydrating;
}
function push(c,ev){ev.at=Date.now();c.events.push(ev);if(c.events.length>MAX_EVENTS)c.events.splice(0,c.events.length-MAX_EVENTS);
 const line=`data: ${JSON.stringify(ev)}\n\n`;for(const res of c.clients)res.write(line);
 // Telegram sees every chat's events too: approvals from any of them, replies in its own.
 try{telegram.onEvent(c,ev)}catch{}
 // And the Mac's own banners, for what happens while nobody is looking (ui/alerts.mjs).
 try{alerts.onEvent(c,ev,{phone:telegram.owns(c.id)})}catch{}}
function setBusy(c,busy){if(c.busy===busy)return;c.busy=busy;push(c,{kind:'status',busy})}
function warm(c){if(!c.proc&&canThink()){start(c);idleLater(c)}}
// Chats run delegated work in the background (see background-agents.mjs), which is what keeps the assistant free to talk.
// A worker's report is read against its brief before bisu sees it (review-agent.mjs), and sent back once when something looks missing.
const hookCmd=f=>`'${process.execPath}' '${path.join(here,f).replace(/'/g,"'\\''")}'`;
const BACKGROUND_AGENTS=JSON.stringify({hooks:{PreToolUse:[{matcher:'Agent|Task',hooks:[{type:'command',command:hookCmd('background-agents.mjs')}]}],
 SubagentStop:[{matcher:'developer|publisher|refactorer|researcher',hooks:[{type:'command',command:hookCmd('review-agent.mjs'),timeout:30}]}]}});
function start(c){
 // A folder deleted or renamed since the chat was made: spawn would fail asynchronously, and before
 // this check that error took the whole engine down with every other chat.
 if(!fs.statSync(c.cwd,{throwIfNoEntry:false})?.isDirectory()){
  push(c,{kind:'error',message:`This chat's folder is gone: ${c.cwd}. Start a new chat in a folder that exists.`});setBusy(c,false);return}
 const r=roles();
 const args=['-f',path.join(root,'launch.zsh'),r.BISU_MODEL.value,r.BISU_CODE_MODEL.value,r.BISU_DEV_MODEL.value,path.join(root,'agents.json'),
  '-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--permission-prompt-tool','stdio','--replay-user-messages',
  '--settings',BACKGROUND_AGENTS,
  ...(c.sessionId?['--resume',c.sessionId]:[])];
 c.handoffKey??=randomBytes(16).toString('hex');
 const proc=spawn('zsh',args,{cwd:c.cwd,env:{...process.env,BISU_CHAT_ID:c.id,BISU_BOT:c.bot||bots.DEFAULT,BISU_BOT_MAKER:c.maker?'1':'',BISU_HANDOFF_KEY:c.handoffKey,BISU_HANDOFF_DEPTH:String(c.depth||0)},stdio:['pipe','pipe','pipe']});c.proc=proc;c.models=r;c.costSoFar=0;
 // A chat started in a folder macOS has not granted access to does not fail — zsh blocks in getcwd
 // until the permission dialog is answered, which looks like a spinner forever. Say what is happening.
 // Only when it is actually still the launcher: Claude Code says nothing until the first message, so
 // a healthy chat that is merely waiting for one would otherwise be blamed on the folder every time.
 c.stall=setTimeout(()=>{
  if(c.proc!==proc||c.sessionId||c.events.some(e=>e.kind==='init'))return;
  execFile('/bin/ps',['-o','comm=','-p',String(proc.pid)],(e,out)=>{
   // `exec claude` in launch.zsh replaces zsh; a name that still says zsh never got to start.
   if(c.proc!==proc||c.sessionId||c.events.some(e=>e.kind==='init'))return;
   if(!/zsh\s*$/.test(String(out).trim()))return;
   push(c,{kind:'error',message:`bisu is still waiting to read ${c.cwd}. macOS may be asking whether bisu may access that folder — answer the dialog, or allow bisu in System Settings → Privacy & Security → Files and Folders.`});
  });
 },15000);
 let buf='',err='';
 proc.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;let j;try{j=JSON.parse(line)}catch{continue}handle(c,j)}});
 proc.stderr.on('data',d=>{err=(err+d).slice(-4000)});
 proc.stdin.on('error',()=>{});
 proc.on('error',e=>{clearTimeout(c.stall);if(c.proc!==proc)return;c.proc=null;push(c,{kind:'error',message:`bisu could not start: ${e.message}`});setBusy(c,false)});
 proc.on('close',code=>{clearTimeout(c.stall);if(c.proc!==proc)return;c.proc=null;for(const id of c.pending.keys())push(c,{kind:'approval_done',request_id:id,allow:false,reason:'stopped'});c.pending.clear();
  if(c.tasks.size){c.tasks.clear();pushTasks(c)}if(c.queued.length){c.queued=[];push(c,{kind:'queue',ids:[]})}
  if(code&&code!==143){const msg=err.split('\n').filter(l=>l.trim()&&!/connectors are disabled/.test(l)).slice(-3).join('\n');push(c,{kind:'error',message:`bisu stopped (exit ${code})${msg?': '+msg:''}`})}
  setBusy(c,false)});
}
const send=(c,obj)=>{c.proc?.stdin.write(JSON.stringify(obj)+'\n')};
// Background work (subagents started with run_in_background, background shell commands). The assistant's own turn ends
// while they run, so the person can keep talking; Claude Code wakes the assistant again when one finishes.
function pushTasks(c){push(c,{kind:'tasks',tasks:[...c.tasks.values()]})}
function tasksEvent(c,j){
 if(j.subtype==='task_started'){c.tasks.set(j.task_id,{id:j.task_id,type:j.task_type,agent:j.subagent_type||null,description:j.description||'',started:Date.now(),stoppable:j.task_type==='local_agent'});pushTasks(c)}
 else if(j.subtype==='task_progress'){const t=c.tasks.get(j.task_id);if(t){t.step=j.description||'';pushTasks(c)}}
 else if(j.subtype==='task_notification'||(j.subtype==='task_updated'&&/completed|failed|killed|stopped/.test(j.patch?.status||''))){
  const t=c.tasks.get(j.task_id);if(!t)return;c.tasks.delete(j.task_id);if(t.type==='local_agent')push(c,{kind:'task_done',agent:t.agent,description:t.description,status:j.status||j.patch?.status});pushTasks(c)}
 else if(j.subtype==='background_tasks_changed'){const live=new Set((j.tasks||[]).map(t=>t.task_id));let changed=false;for(const id of c.tasks.keys())if(!live.has(id)){c.tasks.delete(id);changed=true}if(changed)pushTasks(c)}
 if(!c.tasks.size&&!c.busy&&!c.pending.size)idleLater(c)}
// Messages sent while the assistant is busy wait inside Claude Code and are taken together at the next turn.
// --replay-user-messages echoes each message when it is taken, which is when it stops being "waiting".
function replayed(c,content){
 const text=typeof content==='string'?content:Array.isArray(content)?content.filter(b=>b?.type==='text').map(b=>b.text).join('\n'):'';
 if(!text||Array.isArray(content)&&content.some(b=>b?.type==='tool_result'))return false;
 const taken=c.queued.filter(q=>text.includes(q.text));
 if(taken.length){c.queued=c.queued.filter(q=>!taken.includes(q));push(c,{kind:'queue',ids:c.queued.map(q=>q.id)})}
 return true}
function handle(c,j){
 const parent=j.parent_tool_use_id||null;
 if(j.type==='system'&&j.subtype==='init'){c.sessionId=j.session_id;c.native=!!j.bisu_native;saveChats();clearTimeout(c.stall);push(c,{kind:'init',sessionId:j.session_id,model:j.model,cwd:j.cwd});return}
 if(j.type==='system'&&/^task_|^background_tasks_changed$/.test(j.subtype||'')){tasksEvent(c,j);return}
 // bisu's own engine: what the judge decided, and actions it cleared without asking.
 if(j.type==='system'&&j.subtype==='auto_allowed'){push(c,{kind:'auto_allowed',tool:j.tool_name,input:j.input,reason:j.reason||'',judged:true});return}
 if(j.type==='system'&&j.subtype==='bisu_judgment'){const {type,subtype,session_id,kind,...rest}=j;push(c,{...rest,kind:'judgment',judge:kind});return}
 // A finished background task wakes the assistant up without a message from the person: that is a turn too.
 if(!parent&&!c.busy&&(j.type==='stream_event'||j.type==='assistant'))setBusy(c,true);
 if(j.type==='stream_event'){const e=j.event;if(e?.type==='content_block_delta'&&e.delta?.type==='text_delta')push(c,{kind:'delta',text:e.delta.text,parent});return}
 if(j.type==='assistant'){for(const b of j.message?.content||[]){
   if(b.type==='text'&&b.text){if(!parent)c.lastText=b.text;push(c,{kind:'text',text:b.text,parent,model:j.message.model})}
   else if(b.type==='tool_use')push(c,{kind:'tool',id:b.id,name:b.name,input:b.input,parent})}return}
 if(j.type==='user'&&!parent&&replayed(c,j.message?.content))return;
 if(j.type==='user'){const content=j.message?.content;if(Array.isArray(content))for(const b of content)if(b.type==='tool_result'){
   const text=typeof b.content==='string'?b.content:Array.isArray(b.content)?b.content.map(x=>x.text||'').join('\n'):'';push(c,{kind:'tool_result',id:b.tool_use_id,text:text.slice(0,4000),error:!!b.is_error,parent})}return}
 if(j.type==='control_request'&&j.request?.subtype==='can_use_tool'){const q=j.request;
  if(c.allowTools.has(q.tool_name)){send(c,{type:'control_response',response:{subtype:'success',request_id:j.request_id,response:{behavior:'allow',updatedInput:q.input}}});push(c,{kind:'auto_allowed',tool:q.tool_name,input:q.input});return}
  c.pending.set(j.request_id,q);push(c,{kind:'approval',request_id:j.request_id,tool:q.tool_name,input:q.input,description:q.description||'',parent});handoffUp(c,{kind:'approval',request_id:j.request_id,tool:q.tool_name,input:q.input,description:q.description||''});return}
 if(j.type==='result'){c.turnsDone++;
  const usage={};for(const [m,u] of Object.entries(j.modelUsage||{}))usage[m]={input:(u.inputTokens||0)+(u.cacheCreationInputTokens||0),cacheRead:u.cacheReadInputTokens||0,output:u.outputTokens||0};
  // modelUsage adds up over the whole process, so a turn's cost is the difference from the previous result.
  // bisu's own engine reports what it spent at Z.ai's prices; Claude Code's own figure uses Claude's.
  const total=j.bisu_native?(j.total_cost_usd??null):estimate(usage,priceNow()),cost=total==null?null:total-c.costSoFar;if(total!=null)c.costSoFar=total;
  c.lastAt=Date.now();saveChats();
  push(c,{kind:'result',error:!!j.is_error,subtype:j.subtype,turns:j.num_turns,ms:j.duration_ms,cost});setBusy(c,false);idleLater(c);handoffDone(c,j);return}
}
// ---- one bot handing work to another (engine tool bot_handoff) ----
// A chat's engine cannot reach this server (its token stays here), so it writes a request file with the chat's
// own one-time key; the server checks the key, starts a chat of the other bot with the task, answers the file,
// and reports the other bot's answer back into the first chat as a message. Approvals of that chat go up to the
// first one too. A handed-off chat may hand off once more, no deeper (MAX_HANDOFF).
const HANDOFF_DIR=path.join(path.dirname(CONFIG),'handoff');
const MAX_HANDOFF=2;
function handoffUp(k,ev){const h=k.handoff;if(!h)return;const o=chats.get(h.from);if(!o)return;push(o,{...ev,via:{chat:k.id,bot:h.botName}})}
async function handoffDone(k,j){const h=k.handoff;if(!h||k.busy||k.tasks?.size||h.reported)return;h.reported=true;const o=chats.get(h.from);if(!o)return;
 const text=String(k.lastText||'(답이 없었어요)').slice(0,6000),ok=!j.is_error;
 push(o,{kind:'handoff',id:k.id,bot:k.bot,botName:h.botName,task:h.task,status:ok?'done':'error'});
 // The first bot reads the report like a message, and answers the person from it.
 if(!o.proc)start(o);
 if(o.busy){o.queued.push({id:randomUUID(),text:`[${h.botName} 보고`})}else setBusy(o,true);
 send(o,{type:'user',message:{role:'user',content:`[${h.botName} 보고 — 넘긴 일: ${h.task.slice(0,200)}]\n${ok?text:'끝까지 하지 못했어요: '+text}\n\n(이 보고를 확인하고, 사람에게 한두 줄로 알려 줘.)`}})}
async function handoffTick(){let names=[];try{names=fs.readdirSync(HANDOFF_DIR)}catch{return}
 for(const n of names){if(!/^[0-9a-f-]{36}\.json$/.test(n))continue;const f=path.join(HANDOFF_DIR,n);let r=null;try{r=JSON.parse(fs.readFileSync(f,'utf8'))}catch{continue}
  const o=chats.get(r?.chat);
  if(!o||!o.handoffKey||r.key!==o.handoffKey){try{if(Date.now()-fs.statSync(f).mtimeMs>10*60e3)fs.rmSync(f,{force:true})}catch{}continue}
  fs.rmSync(f,{force:true});
  const answer=x=>{try{fs.writeFileSync(f.replace(/\.json$/,'.res.json'),JSON.stringify(x))}catch{}};
  const depth=(o.depth||0)+1,want=String(r.bot||'').replace(/^@/,'').trim().toLowerCase();
  const all=bots.list(),target=all.find(b=>b.id===want||b.name.toLowerCase()===want)||(want?all.find(b=>b.name.toLowerCase().includes(want)):null);
  if(depth>MAX_HANDOFF){answer({ok:false,error:`넘긴 일을 또 넘길 수는 ${MAX_HANDOFF}단계까지예요. 직접 하거나 사람에게 물어봐 주세요.`});continue}
  if(!target){answer({ok:false,error:`그런 봇이 없어요: ${r.bot}. 있는 봇: ${all.map(b=>b.name).join(', ')}`});continue}
  if(target.id===(o.bot||bots.DEFAULT)){answer({ok:false,error:'자기 자신에게는 넘길 수 없어요. 직접 하거나 담당 에이전트에게 맡기세요.'});continue}
  const task=String(r.task||'').slice(0,4000);if(!task.trim()){answer({ok:false,error:'넘길 일이 비어 있어요.'});continue}
  const fromName=bots.resolve(o.bot).name,k=await newChat({bot:target.id});
  k.depth=depth;k.title=`${fromName}에게서 · ${task.slice(0,40)}`;k.handoff={from:o.id,botName:target.name,task};
  (o.handoffs??=new Map()).set(k.id,{bot:target.id});
  say(k,`[${fromName}가 넘긴 일]\n${task}\n\n이 대화의 답이 ${fromName}에게 그대로 전달돼요. 끝나면 결과를 짧게 정리해 주세요.`);
  push(o,{kind:'handoff',id:k.id,bot:target.id,botName:target.name,task,status:'running'});
  answer({ok:true,bot:target.name,chat:k.id})}}
setInterval(()=>{handoffTick().catch(e=>console.error('bisu handoff:',e.message))},1000).unref?.();
// A job's card continues the run that produced it, so "그럼 고쳐" has the whole context; a suggestion
// starts a fresh chat and sends what it proposed.
// The cards a goal left that its answer (or its removal) settles.
function goalCardsDone(id){for(const it of proactive.snapshot().items)if(it.goal===id&&it.status==='new')try{proactive.resolve(it.id,'dismissed')}catch{}}
async function acceptSuggestion(item){
 proactive.resolve(item.id,'accepted');
 if(item.kind==='job'){if(!item.sessionId)return null;return newChat({cwd:item.cwd||undefined,resume:item.sessionId})}
 const c=await newChat({cwd:item.cwd||undefined});say(c,item.action);return c}
async function newChat({cwd,resume,bot,maker}){
 // A bot's chat starts in the bot's folder unless one is given; the bot-making chat belongs to the default bot.
 const owner=maker?bots.DEFAULT:bots.validId(bot)&&bots.get(bot)?bot:bots.DEFAULT;
 const dir=path.resolve(String(cwd||bots.resolve(owner).cwd||os.homedir()).replace(/^~(?=\/|$)/,os.homedir()));
 if(!fs.statSync(dir,{throwIfNoEntry:false})?.isDirectory())throw Error('not a folder: '+dir);
 const c={id:randomUUID(),cwd:dir,title:null,busy:false,proc:null,sessionId:resume||null,events:[],clients:new Set(),pending:new Map(),allowTools:new Set(),tasks:new Map(),queued:[],turnsDone:0,costSoFar:0,created:Date.now(),lastAt:Date.now(),bot:owner,maker:!!maker};
 if(resume){if(!/^[0-9a-f-]{36}$/.test(resume))throw Error('bad session id');const past=await pastMessages(resume);
  c.title=cleanTitle(past.find(m=>m.kind==='user')?.text)||'Resumed session';push(c,{kind:'resumed',sessionId:resume,count:past.length});for(const m of past)push(c,{...m,past:true})}
 chats.set(c.id,c);saveChats();warm(c);return c}
function say(c,text){
 c.lastAt=Date.now();
 if(!c.title)c.title=cleanTitle(text);
 saveChats();
 clearTimeout(c.idle);if(!c.proc)start(c);
 // start() refuses a folder that is gone and says so in the chat; there is nobody to send this to.
 if(!c.proc)return;
 if(c.busy){const id=randomUUID();c.queued.push({id,text});push(c,{kind:'user',text,queued:id})}
 else{push(c,{kind:'user',text});setBusy(c,true)}
 send(c,{type:'user',message:{role:'user',content:text}})}
function decide(c,{request_id,allow,always,message}){
 // An approval shown here for a bot this chat handed work to is that chat's to answer.
 if(!c.pending.has(request_id))for(const id of c.handoffs?.keys?.()||[]){const k=chats.get(id);if(k?.pending.has(request_id))return decide(k,{request_id,allow,always,message})}
 const q=c.pending.get(request_id);if(!q)throw Error('no such approval (already answered?)');c.pending.delete(request_id);
 if(allow&&always)c.allowTools.add(q.tool_name);
 send(c,{type:'control_response',response:{subtype:'success',request_id,response:allow?{behavior:'allow',updatedInput:q.input}:{behavior:'deny',message:message||'The person declined this on the bisu page.'}}});
 push(c,{kind:'approval_done',request_id,allow:!!allow,always:!!(allow&&always),tool:q.tool_name});handoffUp(c,{kind:'approval_done',request_id,allow:!!allow,tool:q.tool_name})}
function stop(c){if(!c.proc)return;send(c,{type:'control_request',request_id:randomUUID(),request:{subtype:'interrupt'}});
 // A model that ignores the interrupt still gets stopped; the next message resumes the session.
 const p=c.proc;setTimeout(()=>{if(c.proc===p&&c.busy)p.kill('SIGTERM')},4000)}
function close(c){clearTimeout(c.idle);c.proc?.kill('SIGTERM');for(const res of c.clients)res.end();chats.delete(c.id);saveChats()}

// ---- server ----
const json=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body))};
async function body(req){if(!(req.headers['content-type']||'').startsWith('application/json'))throw Object.assign(Error('json only'),{status:415});
 let s='';for await(const ch of req){s+=ch;if(s.length>200000)throw Object.assign(Error('too large'),{status:413})}return JSON.parse(s||'{}')}
const tokenOk=(req,url)=>(req.headers['x-bisu-token']||url.searchParams.get('token'))===TOKEN;
const server=http.createServer(async(req,res)=>{
 const host=req.headers.host||'';if(host!==`127.0.0.1:${PORT}`&&host!==`localhost:${PORT}`)return json(res,403,{error:'host'});
 if(req.headers.origin&&req.headers.origin!==`http://${host}`)return json(res,403,{error:'origin'});
 const url=new URL(req.url,'http://x'),p=url.pathname,m=req.method;
 try{
  // The page needs the token to talk to this server, so it is served with the token in it — which
  // means the page itself must not be readable without one, or any local process could fetch it,
  // take the token out and drive the assistant. The window always opens with ?token=.
  if(m==='GET'&&p==='/'){
   if(!tokenOk(req,url))return json(res,401,{error:'token'});
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'});
   return res.end(fs.readFileSync(path.join(here,'index.html'),'utf8').replace('__BISU_TOKEN__',TOKEN))}
  if(!p.startsWith('/api/'))return json(res,404,{error:'not found'});
  if(!tokenOk(req,url))return json(res,401,{error:'token'});
  if(m==='GET'&&p==='/api/roles')return json(res,200,{roles:roles(),config:CONFIG});
  // Page preferences live here, not in the page's storage: the menu bar app picks a new port on
  // every launch, and a new port is a new origin with empty storage.
  if(m==='GET'&&p==='/api/prefs')return json(res,200,readPrefs());
  if(m==='POST'&&p==='/api/prefs')return json(res,200,writePrefs(await body(req)));
  if(m==='GET'&&p==='/api/models')return json(res,200,{models:await models()});
  if(m==='GET'&&p==='/api/account')return json(res,200,await account());
  if(m==='GET'&&p==='/api/native')return json(res,200,await nativeInfo());
  // Asking macOS for calendar access from Settings, rather than in the middle of a request.
  if(m==='POST'&&p==='/api/calendar/access')return json(res,200,await calendarAccess('request'));
  if(m==='GET'&&p==='/api/runs')return json(res,200,{runs:await runs()});
  // Past conversations, the same index the assistant's session_search uses (ui/sessions.mjs);
  // refreshed in a child process first so a chat that just ended is already in it.
  if(m==='GET'&&p==='/api/search'){const q=url.searchParams.get('q')||'';const r=await sessions.refresh();
   return json(res,200,{...sessions.search(q,{days:Number(url.searchParams.get('days'))||0,limit:12}),refreshError:r?.error||null})}
  if(m==='POST'&&p==='/api/roles'){const input=await body(req),next=readConfig();
   for(const k of Object.keys(ROLES)){const v=input[k];if(v===null||v===ROLES[k])delete next[k];else if(typeof v==='string'){if(!SLUG.test(v))return json(res,400,{error:`not an OpenRouter slug: ${v}`});next[k]=v}}
   writeConfig(next);return json(res,200,{roles:roles()})}
  // Memory: the files the assistant keeps and the exact block a new run is given. Editing here is
  // immediate for the next chat or bisu run; a chat that is already running keeps what it started with.
  // Each bot's own memory: ?bot= (or bot in the body) picks the folder; none is the default bot's.
  const memBot=bots.validId(url.searchParams.get('bot'))?url.searchParams.get('bot'):bots.DEFAULT;
  if(m==='GET'&&p==='/api/memory')return json(res,200,memory.inBot(memBot,()=>memory.snapshot()));
  if(m==='POST'&&p==='/api/memory'){const b=await body(req);return json(res,200,memory.inBot(bots.validId(b.bot)?b.bot:memBot,()=>memory.save(b)))}
  // What already looks like the memory being written. Returns candidates and never writes, so the page
  // decides: edit the one that is there, or keep both.
  if(m==='POST'&&p==='/api/memory/check'){const b=await body(req);return json(res,200,{candidates:memory.inBot(bots.validId(b.bot)?b.bot:memBot,()=>memory.check(b))})}
  const mm=/^\/api\/memory\/([^/]+)$/.exec(p);
  if(mm&&m==='DELETE')return json(res,200,memory.inBot(memBot,()=>memory.remove(decodeURIComponent(mm[1]))));
  // Proactive suggestions: what bisu brings without being asked. The run itself is read-only and
  // happens in its own process; accepting one only opens an ordinary chat and sends the request.
  // Telegram (ui/telegram.mjs): its state and settings, a fresh pairing code, unpairing, a test message.
  if(m==='GET'&&p==='/api/telegram')return json(res,200,telegram.snapshot());
  if(m==='POST'&&p==='/api/telegram')return json(res,200,telegram.configure(await body(req)));
  if(m==='POST'&&p==='/api/telegram/code')return json(res,200,telegram.newCode());
  if(m==='POST'&&p==='/api/telegram/unpair')return json(res,200,await telegram.unpair());
  if(m==='POST'&&p==='/api/telegram/test')return json(res,200,await telegram.test());
  // Opening something outside the page for a setup step: only these, never an address the page sends.
  if(m==='POST'&&p==='/api/open'){const {what}=await body(req),tg=telegram.snapshot();
   const target={botfather:['https://t.me/BotFather'],pair:tg.link?[tg.link]:null,dec:['-b','local.dec.browser']}[what];
   if(!target)return json(res,400,{error:'nothing to open'});
   execFile('/usr/bin/open',target,e=>{});return json(res,200,{ok:true})}
  // The keys are read when the shell starts the engine, so a key saved in dec a moment ago needs a fresh
  // engine: this one exits and the shell starts the next (only under the app; a terminal run would just stop).
  if(m==='POST'&&p==='/api/restart'){if(PARENT!=='stdin')return json(res,400,{error:'터미널에서 띄운 bisu는 여기서 다시 켤 수 없어요'});
   json(res,200,{ok:true});setTimeout(()=>process.exit(0),300);return}
  // Banners, meeting alerts and keeping the Mac awake (ui/alerts.mjs). The shell reads /api/notices.
  if(m==='GET'&&p==='/api/alerts')return json(res,200,await alerts.snapshot());
  if(m==='POST'&&p==='/api/alerts')return json(res,200,await alerts.configure(await body(req)));
  if(m==='POST'&&p==='/api/alerts/test')return json(res,200,alerts.test());
  if(m==='GET'&&p==='/api/notices')return json(res,200,alerts.since(Number(url.searchParams.get('after'))||0));
  // Goals (ui/goals.mjs): the list, a new one, and what the person does to one.
  if(m==='GET'&&p==='/api/goals')return json(res,200,goals.snapshot());
  if(m==='POST'&&p==='/api/goals'){goals.create(await body(req));return json(res,200,goals.snapshot())}
  const gm=/^\/api\/goals\/(g-[0-9a-f]{6})$/.exec(p);
  if(gm&&m==='POST'){const {action,text}=await body(req),id=gm[1];
   if(action==='run'){if(!process.env.GLM_API_KEY)return json(res,400,{error:'Z.ai 키가 없어요: Dec에 https://api.z.ai 키를 저장해 주세요.'});
    goals.run(id,{force:true}).catch(e=>console.error('bisu goals:',e.message));await new Promise(r=>setTimeout(r,100));return json(res,202,goals.snapshot())}
   if(action==='answer'){goals.answer(id,text);goalCardsDone(id)}
   else if(action==='pause'||action==='resume')goals.setStatus(id,action==='pause'?'paused':'active');
   else if(action==='delete'){goals.remove(id);goalCardsDone(id)}
   else return json(res,400,{error:'unknown action'});
   return json(res,200,goals.snapshot())}
  if(m==='GET'&&p==='/api/cubench')return json(res,200,cubench.snapshot());
  if(m==='POST'&&p==='/api/cubench')return json(res,200,cubench.start(await body(req)));
  if(m==='POST'&&p==='/api/cubench/stop')return json(res,200,cubench.stop());
  if(m==='GET'&&p==='/api/briefing')return json(res,200,{...briefing.snapshot(),access:await briefing.access()});
  if(m==='POST'&&p==='/api/briefing')return json(res,200,briefing.configure(await body(req)));
  if(m==='POST'&&p==='/api/briefing/run')return json(res,200,await briefing.run({force:true}));
  if(m==='GET'&&p==='/api/proactive')return json(res,200,proactive.snapshot());
  if(m==='POST'&&p==='/api/proactive')return json(res,200,proactive.configure(await body(req)));
  if(m==='POST'&&p==='/api/proactive/run'){
   if(!canThink())return json(res,400,{error:noKey()||'x'});
   const why=proactive.due(Date.now(),true);
   if(why)return json(res,200,{...proactive.snapshot(),skipped:why});
   // Answered at once: the run takes a minute, and the page is already polling for the result.
   proactive.run({reason:'page',force:true});
   return json(res,202,proactive.snapshot())}
  const pm=/^\/api\/proactive\/([0-9a-f-]{36})$/.exec(p);
  if(pm&&m==='POST'){
   const {action}=await body(req),item=proactive.get(pm[1]);
   if(!item)return json(res,404,{error:'no such suggestion'});
   if(action==='seen'){proactive.markSeen(item.id);return json(res,200,proactive.snapshot())}
   if(action==='dismiss'){proactive.resolve(item.id,'dismissed');return json(res,200,proactive.snapshot())}
   if(action!=='accept')return json(res,400,{error:'unknown action'});
   if(!canThink())return json(res,400,{error:noKey()||''});
   const c=await acceptSuggestion(item);
   return json(res,200,{...proactive.snapshot(),...(c?{chat:publicChat(c)}:{})})}
  // Scheduled jobs (ui/jobs.mjs): the files are the jobs; this lists them with their state, runs one
  // now (answered at once, the page polls), flips enabled in the file, or deletes the file.
  if(m==='GET'&&p==='/api/jobs')return json(res,200,jobs.snapshot());
  // Any file name a job can have, Korean included; jobs.mjs refuses anything that is a path.
  const jm=/^\/api\/jobs\/([^/]{1,400})$/.exec(p);
  if(jm){try{jm[1]=decodeURIComponent(jm[1])}catch{return json(res,400,{error:'bad job name'})}}
  if(jm&&m==='POST'){const {action}=await body(req);
   try{
    if(action==='run'){const s=jobs.snapshot(),j=s.jobs.find(x=>x.slug===jm[1]);
     if(!j)return json(res,404,{error:'no such job'});if(j.error)return json(res,400,{error:j.error});if(j.needsApproval)return json(res,409,{error:'approve this job first'});if(s.running)return json(res,409,{error:'another job is running'});
     if(!canThink())return json(res,400,{error:noKey()||''});
     jobs.run(jm[1],{reason:'page',force:true}).catch(e=>console.error('bisu jobs:',e.message));
     return json(res,202,jobs.snapshot())}
    if(action==='approve')return json(res,200,jobs.approve(jm[1]));
    if(action==='enable'||action==='disable')return json(res,200,jobs.setEnabled(jm[1],action==='enable'));
    if(action==='awake'||action==='asleep')return json(res,200,jobs.setAwake(jm[1],action==='awake'));
    if(action==='delete')return json(res,200,jobs.remove(jm[1]));
    return json(res,400,{error:'unknown action'})
   }catch(e){return json(res,e.status||500,{error:e.message})}}
  // Bots (ui/bots.mjs): list, create (the quick form, or after the making chat's preview), change, delete.
  if(m==='GET'&&p==='/api/bots')return json(res,200,{bots:bots.list(),default:bots.DEFAULT});
  if(m==='POST'&&p==='/api/bots')return json(res,200,{bot:bots.create(await body(req)),bots:bots.list()});
  const bm=/^\/api\/bots\/([a-z0-9-]{1,40})$/.exec(p);
  if(bm&&m==='POST'){const b=await body(req);if(b.action==='delete'){bots.remove(bm[1]);return json(res,200,{bots:bots.list()})}return json(res,200,{bot:bots.update(bm[1],b),bots:bots.list()})}
  // Routines (ui/routines.mjs): a bot's saved ways of doing something. Running one is a new chat of its bot;
  // scheduling one writes a job with routine: <slug> (its approval covers the routine's text).
  if(m==='GET'&&p==='/api/routines'){const b=url.searchParams.get('bot');return json(res,200,{routines:routines.list(bots.validId(b)?b:null),jobs:jobs.snapshot().jobs.filter(j=>j.routine).map(j=>({slug:j.slug,routine:j.routine,schedule:j.schedule,enabled:j.enabled,needsApproval:j.needsApproval,nextAt:j.nextAt}))})}
  if(m==='POST'&&p==='/api/routines'){const b=await body(req);return json(res,200,{routine:routines.save(b)})}
  const rm=/^\/api\/routines\/([a-z0-9._-]{1,60})$/.exec(p);
  if(rm&&m==='POST'){const b=await body(req),r=routines.read(rm[1]);if(!r)return json(res,404,{error:'루틴이 없어요'});
   if(b.action==='run'){if(r.paused)return json(res,409,{error:'일시정지된 루틴이에요. 먼저 재개해 주세요.'});if(!canThink())return json(res,400,{error:noKey()||''});
    const c=await newChat({bot:r.bot});c.title=`루틴 · ${r.name}`;say(c,routines.prompt(r,b.values||{}));return json(res,200,{chat:publicChat(c)})}
   if(b.action==='pause'||b.action==='resume')return json(res,200,{routine:routines.update(r.slug,{paused:b.action==='pause'})});
   if(b.action==='delete')return json(res,200,routines.remove(r.slug));
   if(b.action==='schedule'){const cron=String(b.cron||'').trim();try{jobs.parseCron(cron)}catch(e){return json(res,400,{error:`일정 형식이 맞지 않아요: ${e.message}`})}
    const slug=`routine-${r.slug}`.slice(0,60),file=path.join(jobs.DIR,`${slug}.md`);fs.mkdirSync(jobs.DIR,{recursive:true});
    fs.writeFileSync(file,`---\nname: ${r.name}\nschedule: ${cron}\ncwd: ${bots.resolve(r.bot).cwd}\ntools: ${r.tools}\nbot: ${r.bot}\nroutine: ${r.slug}\n---\n`);
    return json(res,200,{job:jobs.snapshot().jobs.find(j=>j.slug===slug)||null})}
   return json(res,200,{routine:routines.update(r.slug,b)})}
  if(m==='GET'&&p==='/api/chats')return json(res,200,{chats:[...chats.values()].map(publicChat).sort((a,b)=>b.lastAt-a.lastAt),home:os.homedir()});
  if(m==='POST'&&p==='/api/chats'){if(!canThink())return json(res,400,{error:noKey()||''});const c=await newChat(await body(req));return json(res,200,{chat:publicChat(c)})}
  const cm=/^\/api\/chats\/([0-9a-f-]{36})(\/[a-z]+)?$/.exec(p);const c=cm&&chats.get(cm[1]);
  if(cm&&!c)return json(res,404,{error:'chat not found'});
  if(c&&m==='GET'&&cm[2]==='/events'){await hydrate(c);res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
   res.write(`data: ${JSON.stringify({kind:'hello',chat:publicChat(c)})}\n\n`);for(const ev of c.events)res.write(`data: ${JSON.stringify(ev)}\n\n`);
   // Watched again: the short "nobody is looking" timer from a hidden panel must not stop Claude Code
   // in front of the person a few seconds later.
   c.clients.add(res);warm(c);if(c.proc)idleLater(c);const ping=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},20000);
   req.on('close',()=>{clearInterval(ping);c.clients.delete(res);unwatched(c)});return}
  if(c&&m==='POST'&&cm[2]==='/send'){const {text}=await body(req);if(typeof text!=='string'||!text.trim())return json(res,400,{error:'empty'});say(c,text.trim());return json(res,200,{ok:true})}
  if(c&&m==='POST'&&cm[2]==='/approve'){decide(c,await body(req));return json(res,200,{ok:true})}
  if(c&&m==='POST'&&cm[2]==='/stop'){stop(c);return json(res,200,{ok:true})}
  // One worker, stopped from the task bar; the rest of the chat goes on. Claude Code and bisu's own
  // engine both take this control request.
  if(c&&m==='POST'&&cm[2]==='/stoptask'){const {task_id}=await body(req);if(!/^[0-9a-f]{8}$/.test(String(task_id||'')))return json(res,400,{error:'bad task'});
   send(c,{type:'control_request',request_id:randomUUID(),request:{subtype:'stop_task',task_id}});return json(res,200,{ok:true})}
  if(c&&m==='DELETE'&&!cm[2]){close(c);return json(res,200,{ok:true})}
  json(res,404,{error:'not found'})
 }catch(e){json(res,e.status||(e instanceof SyntaxError?400:502),{error:String(e?.message||e),...(e.holder?{holder:e.holder}:{})})}
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`bisu ui: port ${PORT} is busy (set BISU_UI_PORT)`:`bisu ui: ${e.message}`);process.exit(1)});
server.listen(PORT,'127.0.0.1',()=>{const u=`http://127.0.0.1:${PORT}`;console.error(`bisu ui → ${u}  (key: ${keyMode}; Ctrl-C to stop)`);
 if(!process.env.BISU_UI_NO_OPEN)execFile('open',[`${u}/?token=${TOKEN}`],()=>{})});

// What bisu may bring on its own. The engine is the only thing that runs while nobody is watching,
// so the schedule lives here; the page and the menu item only ask for one now.
const proactiveContext=async()=>({
 runs:await runs().catch(()=>[]),
 chats:[...chats.values()].filter(c=>c.sessionId).map(c=>({cwd:c.cwd,title:c.title})).slice(0,6),
 models:{main:roles().BISU_MODEL.value,code:roles().BISU_CODE_MODEL.value,dev:roles().BISU_DEV_MODEL.value},
 key:canThink(),
});
proactive.setContext(proactiveContext);
proactive.start();
jobs.setContext(proactiveContext);
jobs.start();
briefing.start();
telegram.attach({newChat,say,decide,stop,getChat:id=>chats.get(id),accept:acceptSuggestion,answerGoal:(id,text)=>{const g=goals.answer(id,text);goalCardsDone(id);return g}});
telegram.start();
alerts.onNotice(n=>telegram.onNotice(n));
// What counts as 「작업 중」 for keeping the Mac awake: a reply being written, background agents, a job, a goal session.
alerts.setWork(()=>{const work=[];
 for(const c of chats.values()){if(c.busy)work.push({kind:'turn',what:c.title||'대화'});for(const t of c.tasks?.values?.()||[])work.push({kind:'agent',what:t.description||t.agent||'백그라운드 작업'})}
 const job=jobs.runningAwake();if(job)work.push({kind:'job',what:job.name});
 const g=goals.snapshot().running;if(g)work.push({kind:'goal',what:'목표 진행'});
 return {work,forced:job}});
alerts.start();
// A goal that needs the person, or got done, says so as a card: the panel, the banners and Telegram
// all pick cards up from there. A question can be answered on the card, under 목표, or by replying on Telegram.
goals.setQuiet(()=>proactive.isQuiet());
goals.setContext(proactiveContext);
goals.onGoal((kind,g)=>{
 if(kind==='question'){goalCardsDone(g.id);proactive.push({id:randomUUID(),kind:'job',job:'goal',goal:g.id,ask:true,title:g.title,body:g.question.text,cwd:g.cwd})}
 else if(kind==='done')proactive.push({id:randomUUID(),kind:'job',job:'goal',goal:g.id,title:`${g.title} — 달성`,body:g.log[g.log.length-1]?.text||'',cwd:g.cwd})});
goals.start(holdsSchedule);
// A web task dec was still doing when its chat moved on: once it ends, the chat hears the result and reports it.
webwaits.start((w,r)=>{
 const how={verified:'끝남',unverified:'끝남',failed:'실패',stopped:'중지됨'}[r.status]||r.status;
 const body=[`작업: ${w.goal}`,`결과: ${how}${r.answer?` — ${r.answer}`:''}${r.reason&&/failed|stopped/.test(r.status)?` (${r.reason})`:''}`,r.url&&`마지막 페이지: ${r.url}`].filter(Boolean).join('\n');
 const c=w.chat&&chats.get(w.chat);
 if(c)say(c,`(dec에서 기다리던 웹 작업이 끝났어요. 결과를 알려 주세요.)\n${body}`);
 else alerts.notice({kind:'reply',title:'웹 작업이 끝났어요',body})});
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{proactive.stop();jobs.stop();briefing.stop();cubench.shutdown();telegram.shutdown();alerts.shutdown();goals.stop();webwaits.stop();releaseSchedule();for(const c of chats.values())c.proc?.kill('SIGTERM');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500)});
// The desktop shell holds this pipe open for as long as it is running, so the pipe closing means the
// shell quit or was force-killed. Without this the engine, dec and every Claude Code run outlive it.
if(PARENT==='stdin'){
 process.stdin.on('end',()=>{proactive.stop();jobs.stop();briefing.stop();cubench.shutdown();telegram.shutdown();alerts.shutdown();goals.stop();webwaits.stop();releaseSchedule();for(const c of chats.values())c.proc?.kill('SIGTERM');process.exit(0)});
 process.stdin.on('error',()=>{});
 process.stdin.resume();
}
