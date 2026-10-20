'use strict';
// Flip chat → swarm while IDLE (after a finished turn), then send a turn: does the restarted session process it?
const fs=require('fs'),path=require('path');const {execFileSync}=require('child_process');
const {RT,BASE,env}=require('./env.cjs');const {KoraClient}=require(RT+'/dist/protocol/client.js');
(async()=>{const c=new KoraClient(env.KORA_SOCKET_PATH);await c.connect();c.setMaxListeners(50);
const dir=path.join(BASE,'repos','idleflip-'+Date.now().toString(36));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(dir+'/a.txt','x');
const g=(...a)=>execFileSync('git',a,{cwd:dir,stdio:'ignore'});g('init','-q','-b','main');g('add','.');g('-c','user.email=e@k','-c','user.name=e','commit','-qm','i');
const th=await c.call('chat.thread.create',{agent:'claude',cwd:dir,agentMode:'chat',model:{model:'claude-sonnet-5'},title:'idleflip'});const id=th.threadId??th.id;
await c.call('chat.events.subscribe',{threadIds:[id]});
const turn=async(text)=>{const ev=[];const p=new Promise(r=>{const on=e=>{if(e?.threadId!==id)return;ev.push(e);if(e.type==='turn.settled'){c.off('chat.event',on);r(e)}};c.on('chat.event',on)});await c.call('chat.turn.send',{threadId:id,text});const s=await p;return {s,ev,text:ev.filter(e=>e.type==='content.delta').map(e=>e.delta).join('')}};
const a=await turn('Reply with exactly: ONE');console.log('t1',a.s.state,JSON.stringify(a.text));
await c.call('chat.thread.setAgentMode',{threadId:id,agentMode:'swarm'});
const b=await turn('Reply with exactly: TWO');console.log('t2',b.s.state,JSON.stringify(b.text),b.s.usage&&b.s.usage.outputTokens);
const d=await turn('Reply with exactly: THREE');console.log('t9',d.s.state,JSON.stringify(d.text),d.s.usage&&d.s.usage.outputTokens);
process.exit(0)})().catch(e=>{console.error(e);process.exit(1)});
