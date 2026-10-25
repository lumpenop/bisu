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

const here=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(here);
const PORT=Number(process.env.BISU_UI_PORT||7878);
// The desktop shell (mac/) starts this engine itself and needs to read /api/chats for the tray
// and its approval notifications, so it may pass its own token. Without it, a fresh one each run.
const TOKEN=/^[0-9a-f]{32,64}$/.test(process.env.BISU_UI_TOKEN||'')?process.env.BISU_UI_TOKEN:randomBytes(24).toString('hex');
const CONFIG=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),'.config'),'bisu','models');
const PROJECTS=path.join(os.homedir(),'.claude','projects');
const HELPER=path.join(os.homedir(),'Library','Application Support','Dec Browser','bin','dec-secret-helper');
const ROLES={BISU_MODEL:'z-ai/glm-5.3',BISU_DEV_MODEL:'deepseek/deepseek-v4.1-flash',BISU_CODE_MODEL:'qwen/qwen3.8-max-0902'};
// Old names still read from the config file and the environment.
const ALIAS={BISU_FAST_MODEL:'BISU_DEV_MODEL'};
const SLUG=/^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9._:-]+$/;
const KEY=process.env.OPENROUTER_API_KEY||'';
const KEY_BASE=(process.env.OPENROUTER_BASE_URL||'https://openrouter.ai').replace(/\/$/,'');
const keyMode=!KEY?'none':KEY.startsWith('dec-use-only-')?'use-only':'plain';

// ---- models config ----
function readConfig(){const out={};try{for(const line of fs.readFileSync(CONFIG,'utf8').split('\n')){const m=/^(BISU_[A-Z_]+)=(\S+)$/.exec(line.trim());const k=m&&(ALIAS[m[1]]||m[1]);if(k in ROLES&&SLUG.test(m[2])&&!(k in out&&ALIAS[m[1]]))out[k]=m[2]}}catch{}return out}
function writeConfig(models){fs.mkdirSync(path.dirname(CONFIG),{recursive:true});const tmp=CONFIG+'.tmp';
 fs.writeFileSync(tmp,'# bisu models, written by `bisu ui`. Exported BISU_* variables override these.\n'+Object.keys(ROLES).filter(k=>models[k]).map(k=>`${k}=${models[k]}`).join('\n')+'\n');fs.renameSync(tmp,CONFIG)}
const envOf=k=>process.env[k]||Object.keys(ALIAS).filter(a=>ALIAS[a]===k).map(a=>process.env[a]).find(Boolean)||null;
function roles(){const saved=readConfig();return Object.fromEntries(Object.entries(ROLES).map(([k,d])=>[k,{value:envOf(k)||saved[k]||d,saved:saved[k]||null,default:d,env:envOf(k)}]))}

// ---- OpenRouter ----
let modelCache={at:0,list:null};
async function models(){if(modelCache.list&&Date.now()-modelCache.at<10*60e3)return modelCache.list;
 const r=await fetch('https://openrouter.ai/api/v1/models',{signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('models '+r.status);
 const list=(await r.json()).data.map(m=>({id:m.id,name:m.name,context:m.context_length,tools:(m.supported_parameters||[]).includes('tools'),
  prompt:Number(m.pricing?.prompt)||0,completion:Number(m.pricing?.completion)||0,cacheRead:Number(m.pricing?.input_cache_read)||0}));
 modelCache={at:Date.now(),list};return list}
async function priceMap(){try{return new Map((await models()).map(m=>[m.id,m]))}catch{return new Map()}}
// usage: {model: {input, cacheRead, output}} -> USD at OpenRouter list prices, or null when a model has no price.
function estimate(usage,price){let cost=0;for(const [id,u] of Object.entries(usage)){const pr=price.get(id);if(!pr)return null;cost+=u.input*pr.prompt+u.cacheRead*(pr.cacheRead||pr.prompt)+u.output*pr.completion}return cost}
async function keyGet(p){const r=await fetch(KEY_BASE+p,{headers:{authorization:'Bearer '+KEY},signal:AbortSignal.timeout(30000)});const j=await r.json().catch(()=>null);if(!r.ok)throw Error((j?.error?.message||j?.error||'HTTP')+' '+r.status);return j?.data}
// Whether the installed dec-secret-helper streams answers (`stream`) or buffers them (older helper, ~200 s per request).
function helperStreams(){return new Promise(resolve=>{if(keyMode!=='use-only')return resolve(null);
 const c=execFile(HELPER,['stream'],{encoding:'utf8',timeout:5000},(e,out)=>{let j=null;try{j=JSON.parse(out)}catch{}resolve(j?.code==='INPUT_INVALID'?true:/^USAGE/.test(j?.code||'')?false:null)});c.on('error',()=>resolve(null));c.stdin.end('')})}
async function account(){
 const streams=await helperStreams();if(!KEY)return {mode:keyMode,streams};
 const [key,credits]=await Promise.allSettled([keyGet('/api/v1/key'),keyGet('/api/v1/credits')]);
 const k=key.status==='fulfilled'?key.value:null;
 return {mode:keyMode,streams,key:k&&{label:k.label,limit:k.limit,limit_remaining:k.limit_remaining,usage_daily:k.usage_daily,usage_weekly:k.usage_weekly,usage_monthly:k.usage_monthly},
  keyError:key.status==='rejected'?key.reason.message:null,credits:credits.status==='fulfilled'?credits.value:null,creditsError:credits.status==='rejected'?credits.reason.message:null}}

// ---- history ----
const fileCache=new Map();// path -> {mtime,size,rows}
function* jsonlFiles(dir,depth=0){let ents=[];try{ents=fs.readdirSync(dir,{withFileTypes:true})}catch{return}
 for(const e of ents){const p=path.join(dir,e.name);if(e.isDirectory()&&depth<3&&e.name!=='memory')yield* jsonlFiles(p,depth+1);else if(e.isFile()&&e.name.endsWith('.jsonl'))yield p}}
const textOf=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(b=>b?.type==='text').map(b=>b.text).join(' '):'';
function scanFile(p,st){const hit=fileCache.get(p);if(hit&&hit.mtime===st.mtimeMs&&hit.size===st.size)return hit.rows;
 let text='';try{text=fs.readFileSync(p,'utf8')}catch{}
 const rows=[];if(/"model":"[a-z0-9][a-z0-9._-]*\//.test(text))for(const line of text.split('\n')){if(!line)continue;let j;try{j=JSON.parse(line)}catch{continue}rows.push(j)}
 fileCache.set(p,{mtime:st.mtimeMs,size:st.size,rows});return rows}
function* transcriptRows(since){for(const p of jsonlFiles(PROJECTS)){let st;try{st=fs.statSync(p)}catch{continue}if(st.mtimeMs<since)continue;yield* scanFile(p,st)}}
async function runs(){const sessions=new Map();
 for(const j of transcriptRows(Date.now()-60*864e5)){if(!j.sessionId)continue;let s=sessions.get(j.sessionId);
  if(!s)sessions.set(j.sessionId,s={id:j.sessionId,start:null,end:null,cwd:null,title:null,prompt:null,turns:0,seen:new Set(),usage:{}});
  if(j.timestamp){const t=Date.parse(j.timestamp);if(!s.start||t<s.start)s.start=t;if(!s.end||t>s.end)s.end=t}
  if(j.cwd&&!s.cwd)s.cwd=j.cwd;if(j.type==='ai-title'&&j.aiTitle)s.title=j.aiTitle;
  if(j.type==='user'&&!j.isSidechain&&!s.prompt){const t=textOf(j.message?.content).trim();if(t&&!t.startsWith('<'))s.prompt=t.slice(0,300)}
  const m=j.message;if(j.type==='assistant'&&m?.model&&m.usage){const id=m.id||j.uuid;if(s.seen.has(id))continue;s.seen.add(id);if(!j.isSidechain)s.turns++;
   const u=s.usage[m.model]??={input:0,cacheRead:0,output:0};u.input+=(m.usage.input_tokens||0)+(m.usage.cache_creation_input_tokens||0);u.cacheRead+=m.usage.cache_read_input_tokens||0;u.output+=m.usage.output_tokens||0}}
 const price=await priceMap();
 return [...sessions.values()].filter(s=>Object.keys(s.usage).some(k=>SLUG.test(k))).map(s=>{const {seen,...rest}=s;return {...rest,cost:estimate(s.usage,price)}})
  .sort((a,b)=>(b.start||0)-(a.start||0)).slice(0,100)}
// The visible conversation of a past session (main thread only), for showing it again when it is resumed.
function pastMessages(sessionId){const out=[];
 for(const j of transcriptRows(Date.now()-60*864e5)){if(j.sessionId!==sessionId||j.isSidechain)continue;
  if(j.type==='user'){const t=textOf(j.message?.content).trim();if(t&&!t.startsWith('<')&&!t.startsWith('[Request interrupted'))out.push({kind:'user',text:t,ts:j.timestamp})}
  if(j.type==='assistant'){const t=textOf(j.message?.content).trim();if(t)out.push({kind:'text',text:t,ts:j.timestamp})}}
 return out.sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts)).slice(-60)}

// ---- chats ----
// One Claude Code process per chat. Events are kept (capped) so a reloaded page can replay the conversation.
const chats=new Map();
const MAX_EVENTS=3000;
// A chat's process is started as soon as the chat is created or opened, so the first message doesn't wait for Claude Code
// to boot. It stays up between messages while the page is watching it, and is stopped after IDLE_MS without activity.
const IDLE_MS=Number(process.env.BISU_UI_IDLE_MIN||30)*60e3;
// Claude Code is by far the largest part of bisu's memory (a few hundred MB), so a chat nobody is looking at should not
// keep it alive. The panel detaches its event stream when it hides, which lands here: nothing is watching, nothing is
// running, so let go after this grace instead of waiting out the full IDLE_MS. Reopening starts it again.
const PARK_MS=Number(process.env.BISU_UI_PARK_SEC||60)*1e3;
function reap(c){
 if(!c.proc||c.busy||c.pending.size)return;
 // SIGTERM only: a half-written turn should still be able to flush.
 try{c.proc.kill('SIGTERM')}catch{}
}
function idleLater(c){
 clearTimeout(c.idle);
 // Watched: keep it warm between messages. Unwatched: a much shorter grace, because the process is pure idle cost then.
 c.idle=setTimeout(()=>reap(c),c.clients.size?IDLE_MS:PARK_MS);
}
function unwatched(c){clearTimeout(c.idle);if(c.proc&&!c.busy&&!c.pending.size)idleLater(c)}
function publicChat(c){return {id:c.id,cwd:c.cwd,title:c.title,busy:c.busy,alive:!!c.proc,sessionId:c.sessionId,pending:c.pending.size,created:c.created}}
function push(c,ev){ev.at=Date.now();c.events.push(ev);if(c.events.length>MAX_EVENTS)c.events.splice(0,c.events.length-MAX_EVENTS);
 const line=`data: ${JSON.stringify(ev)}\n\n`;for(const res of c.clients)res.write(line)}
function setBusy(c,busy){if(c.busy===busy)return;c.busy=busy;push(c,{kind:'status',busy})}
function warm(c){if(!c.proc&&KEY){start(c);idleLater(c)}}
function start(c){
 const r=roles();
 const args=['-f',path.join(root,'launch.zsh'),r.BISU_MODEL.value,r.BISU_CODE_MODEL.value,r.BISU_DEV_MODEL.value,path.join(root,'agents.json'),
  '-p','--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages','--permission-prompt-tool','stdio',
  ...(c.sessionId?['--resume',c.sessionId]:[])];
 const proc=spawn('zsh',args,{cwd:c.cwd,env:process.env,stdio:['pipe','pipe','pipe']});c.proc=proc;c.models=r;c.costSoFar=0;
 // A chat started in a folder macOS has not granted access to does not fail — zsh blocks in getcwd
 // until the permission dialog is answered, which looks like a spinner forever. Say what is happening.
 c.stall=setTimeout(()=>{if(c.proc!==proc||c.sessionId)return;
  push(c,{kind:'error',message:`bisu is still waiting to read ${c.cwd}. macOS may be asking whether bisu may access that folder — answer the dialog, or allow bisu in System Settings → Privacy & Security → Files and Folders.`})},15000);
 let buf='',err='';
 proc.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line.trim())continue;let j;try{j=JSON.parse(line)}catch{continue}handle(c,j)}});
 proc.stderr.on('data',d=>{err=(err+d).slice(-4000)});
 proc.stdin.on('error',()=>{});
 proc.on('close',code=>{clearTimeout(c.stall);if(c.proc!==proc)return;c.proc=null;for(const id of c.pending.keys())push(c,{kind:'approval_done',request_id:id,allow:false,reason:'stopped'});c.pending.clear();
  if(code&&code!==143){const msg=err.split('\n').filter(l=>l.trim()&&!/connectors are disabled/.test(l)).slice(-3).join('\n');push(c,{kind:'error',message:`bisu stopped (exit ${code})${msg?': '+msg:''}`})}
  setBusy(c,false)});
}
const send=(c,obj)=>{c.proc?.stdin.write(JSON.stringify(obj)+'\n')};
function handle(c,j){
 const parent=j.parent_tool_use_id||null;
 if(j.type==='system'&&j.subtype==='init'){c.sessionId=j.session_id;clearTimeout(c.stall);push(c,{kind:'init',sessionId:j.session_id,model:j.model,cwd:j.cwd});return}
 if(j.type==='stream_event'){const e=j.event;if(e?.type==='content_block_delta'&&e.delta?.type==='text_delta')push(c,{kind:'delta',text:e.delta.text,parent});return}
 if(j.type==='assistant'){for(const b of j.message?.content||[]){
   if(b.type==='text'&&b.text)push(c,{kind:'text',text:b.text,parent,model:j.message.model});
   else if(b.type==='tool_use')push(c,{kind:'tool',id:b.id,name:b.name,input:b.input,parent})}return}
 if(j.type==='user'){const content=j.message?.content;if(Array.isArray(content))for(const b of content)if(b.type==='tool_result'){
   const text=typeof b.content==='string'?b.content:Array.isArray(b.content)?b.content.map(x=>x.text||'').join('\n'):'';push(c,{kind:'tool_result',id:b.tool_use_id,text:text.slice(0,4000),error:!!b.is_error,parent})}return}
 if(j.type==='control_request'&&j.request?.subtype==='can_use_tool'){const q=j.request;
  if(c.allowTools.has(q.tool_name)){send(c,{type:'control_response',response:{subtype:'success',request_id:j.request_id,response:{behavior:'allow',updatedInput:q.input}}});push(c,{kind:'auto_allowed',tool:q.tool_name,input:q.input});return}
  c.pending.set(j.request_id,q);push(c,{kind:'approval',request_id:j.request_id,tool:q.tool_name,input:q.input,description:q.description||'',parent});return}
 if(j.type==='result'){c.turnsDone++;
  const usage={};for(const [m,u] of Object.entries(j.modelUsage||{}))usage[m]={input:(u.inputTokens||0)+(u.cacheCreationInputTokens||0),cacheRead:u.cacheReadInputTokens||0,output:u.outputTokens||0};
  // modelUsage adds up over the whole process, so a turn's cost is the difference from the previous result.
  priceMap().then(price=>{const total=estimate(usage,price),cost=total==null?null:total-c.costSoFar;if(total!=null)c.costSoFar=total;
   push(c,{kind:'result',error:!!j.is_error,subtype:j.subtype,turns:j.num_turns,ms:j.duration_ms,cost});setBusy(c,false);idleLater(c)});return}
}
function newChat({cwd,resume}){
 const dir=path.resolve(String(cwd||os.homedir()).replace(/^~(?=\/|$)/,os.homedir()));
 if(!fs.statSync(dir,{throwIfNoEntry:false})?.isDirectory())throw Error('not a folder: '+dir);
 const c={id:randomUUID(),cwd:dir,title:null,busy:false,proc:null,sessionId:resume||null,events:[],clients:new Set(),pending:new Map(),allowTools:new Set(),turnsDone:0,costSoFar:0,created:Date.now()};
 if(resume){if(!/^[0-9a-f-]{36}$/.test(resume))throw Error('bad session id');const past=pastMessages(resume);
  c.title=past.find(m=>m.kind==='user')?.text.slice(0,60)||'Resumed session';push(c,{kind:'resumed',sessionId:resume,count:past.length});for(const m of past)push(c,{...m,past:true})}
 chats.set(c.id,c);warm(c);return c}
function say(c,text){
 if(!c.title)c.title=text.slice(0,60);
 clearTimeout(c.idle);if(!c.proc)start(c);
 push(c,{kind:'user',text});setBusy(c,true);
 send(c,{type:'user',message:{role:'user',content:text}})}
function decide(c,{request_id,allow,always,message}){const q=c.pending.get(request_id);if(!q)throw Error('no such approval (already answered?)');c.pending.delete(request_id);
 if(allow&&always)c.allowTools.add(q.tool_name);
 send(c,{type:'control_response',response:{subtype:'success',request_id,response:allow?{behavior:'allow',updatedInput:q.input}:{behavior:'deny',message:message||'The person declined this on the bisu page.'}}});
 push(c,{kind:'approval_done',request_id,allow:!!allow,always:!!(allow&&always),tool:q.tool_name})}
function stop(c){if(!c.proc)return;send(c,{type:'control_request',request_id:randomUUID(),request:{subtype:'interrupt'}});
 // A model that ignores the interrupt still gets stopped; the next message resumes the session.
 const p=c.proc;setTimeout(()=>{if(c.proc===p&&c.busy)p.kill('SIGTERM')},4000)}
function close(c){clearTimeout(c.idle);c.proc?.kill('SIGTERM');for(const res of c.clients)res.end();chats.delete(c.id)}

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
  if(m==='GET'&&p==='/api/models')return json(res,200,{models:await models()});
  if(m==='GET'&&p==='/api/account')return json(res,200,await account());
  if(m==='GET'&&p==='/api/runs')return json(res,200,{runs:await runs()});
  if(m==='POST'&&p==='/api/roles'){const input=await body(req),next=readConfig();
   for(const k of Object.keys(ROLES)){const v=input[k];if(v===null||v===ROLES[k])delete next[k];else if(typeof v==='string'){if(!SLUG.test(v))return json(res,400,{error:`not an OpenRouter slug: ${v}`});next[k]=v}}
   writeConfig(next);return json(res,200,{roles:roles()})}
  if(m==='GET'&&p==='/api/chats')return json(res,200,{chats:[...chats.values()].map(publicChat).sort((a,b)=>b.created-a.created),home:os.homedir()});
  if(m==='POST'&&p==='/api/chats'){if(!KEY)return json(res,400,{error:'No OpenRouter key: save one for https://openrouter.ai in Dec first.'});const c=newChat(await body(req));return json(res,200,{chat:publicChat(c)})}
  const cm=/^\/api\/chats\/([0-9a-f-]{36})(\/[a-z]+)?$/.exec(p);const c=cm&&chats.get(cm[1]);
  if(cm&&!c)return json(res,404,{error:'chat not found'});
  if(c&&m==='GET'&&cm[2]==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});
   res.write(`data: ${JSON.stringify({kind:'hello',chat:publicChat(c)})}\n\n`);for(const ev of c.events)res.write(`data: ${JSON.stringify(ev)}\n\n`);
   c.clients.add(res);warm(c);const ping=setInterval(()=>{try{res.write(': ping\n\n')}catch{}},20000);
   req.on('close',()=>{clearInterval(ping);c.clients.delete(res);unwatched(c)});return}
  if(c&&m==='POST'&&cm[2]==='/send'){const {text}=await body(req);if(typeof text!=='string'||!text.trim())return json(res,400,{error:'empty'});if(c.busy)return json(res,409,{error:'bisu is still working on the last message'});say(c,text.trim());return json(res,200,{ok:true})}
  if(c&&m==='POST'&&cm[2]==='/approve'){decide(c,await body(req));return json(res,200,{ok:true})}
  if(c&&m==='POST'&&cm[2]==='/stop'){stop(c);return json(res,200,{ok:true})}
  if(c&&m==='DELETE'&&!cm[2]){close(c);return json(res,200,{ok:true})}
  json(res,404,{error:'not found'})
 }catch(e){json(res,e.status||(e instanceof SyntaxError?400:502),{error:String(e?.message||e)})}
});
server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`bisu ui: port ${PORT} is busy (set BISU_UI_PORT)`:`bisu ui: ${e.message}`);process.exit(1)});
server.listen(PORT,'127.0.0.1',()=>{const u=`http://127.0.0.1:${PORT}`;console.error(`bisu ui → ${u}  (key: ${keyMode}; Ctrl-C to stop)`);
 if(!process.env.BISU_UI_NO_OPEN)execFile('open',[`${u}/?token=${TOKEN}`],()=>{})});
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{for(const c of chats.values())c.proc?.kill('SIGTERM');server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500)});
// The desktop shell holds this pipe open for as long as it is running, so the pipe closing means the
// shell quit or was force-killed. Without this the engine, dec and every Claude Code run outlive it.
if(process.env.BISU_UI_PARENT==='stdin'){
 process.stdin.on('end',()=>{for(const c of chats.values())c.proc?.kill('SIGTERM');process.exit(0)});
 process.stdin.on('error',()=>{});
 process.stdin.resume();
}
