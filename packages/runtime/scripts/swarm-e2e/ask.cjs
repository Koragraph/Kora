'use strict';
// Live: in a FULL-ACCESS thread, does AskUserQuestion wait for our answer, and does Claude get it in the same turn?
const fs=require('fs'),path=require('path');const {execFileSync}=require('child_process');
const {RT,BASE,env}=require('./env.cjs');const {KoraClient}=require(RT+'/dist/protocol/client.js');
(async()=>{const c=new KoraClient(env.KORA_SOCKET_PATH);await c.connect();c.setMaxListeners(50);
const dir=path.join(BASE,'repos','ask-'+Date.now().toString(36));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/a.txt','x');
const g=(...a)=>execFileSync('git',a,{cwd:dir,stdio:'ignore'});g('init','-q','-b','main');g('add','.');g('-c','user.email=e@k','-c','user.name=e','commit','-qm','i');
const th=await c.call('chat.thread.create',{agent:'claude',cwd:dir,agentMode:'chat',model:{model:'claude-sonnet-5'},title:'ask'});const id=th.threadId??th.id;
await c.call('chat.session.setPermissionMode',{threadId:id,mode:'full-access'});
await c.call('chat.events.subscribe',{threadIds:[id]});
const ev=[];const t0=Date.now();
const done=new Promise(r=>{c.on('chat.event',async e=>{if(e?.threadId!==id)return;ev.push({...e,dt:Date.now()-t0});
  if(e.type==='user-input.requested'){await new Promise(z=>setTimeout(z,6000));const ans={};(e.questions||[]).forEach((q,i)=>ans[q.id||('q'+i)]=q.options?.[1]?.label||'B');
    console.log('answering after 6 s:',JSON.stringify(ans));await c.call('chat.userInput.respond',{threadId:id,requestId:e.requestId,answers:ans});}
  if(e.type==='turn.settled')r(e);});});
await c.call('chat.turn.send',{threadId:id,text:'Use the AskUserQuestion tool to ask me ONE question: "Pick a color" with options Red and Blue. Then reply with exactly: YOU PICKED <my answer>.'});
const s=await done;
for(const e of ev){if(e.type==='content.delta'||e.type==='thread.token-usage')continue;console.log((e.dt/1000).toFixed(1)+'s',e.type,JSON.stringify(e.output||e.answers||e.state||'').slice(0,160));}
console.log('TEXT:',ev.filter(e=>e.type==='content.delta').map(e=>e.delta).join(''));
process.exit(0)})().catch(e=>{console.error(e);process.exit(1)});
