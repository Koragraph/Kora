'use strict';
// Spawn an opencode worker THROUGH the e2e daemon (agent.spawn, same shape as SwarmService) and sample its screen +
// pane state every 300 ms, to see where the start-up false idle comes from.
const fs=require('fs'),path=require('path'),os=require('os');const {execFileSync}=require('child_process');
const {RT,env}=require('./env.cjs');const {KoraClient}=require(RT+'/dist/protocol/client.js');
const {swarmPaneEnv,writeOpencodePlugin}=require(RT+'/dist/server/swarm-opencode.js');const {swarmWorkerPreamble}=require(RT+'/dist/server/swarm-skill.js');
(async()=>{
const c=new KoraClient(env.KORA_SOCKET_PATH);await c.connect();
const dir=fs.mkdtempSync(require('path').join(require('os').tmpdir(),'ocd-'));const g=(...a)=>execFileSync('git',a,{cwd:dir,stdio:'ignore'});
g('init','-q');fs.writeFileSync(dir+'/README.md','# x\n');g('add','.');g('-c','user.email=t@t','-c','user.name=t','commit','-qm','i');
const rp=dir+'/.kora/swarm/s1.md';fs.mkdirSync(path.dirname(rp),{recursive:true});
const meta={taskId:'s1',provider:'zen',model:'opencode/big-pickle',modelLabel:'big-pickle',phase:'starting',attempt:1,attempts:[],reportPath:rp,report:null,supersededBy:null,previousPaneIds:[],verify:null};
process.env.KORA_HOME=env.KORA_HOME;
const penv=swarmPaneEnv(meta,{apiKey:null,runtimeMode:'full-access'});
const text=[swarmWorkerPreamble({reportPath:rp,taskId:'s1'}),'Create src/a.js exporting add(a,b). Check: node -e "import(\'./src/a.js\').then(m=>console.log(m.add(1,2)))" prints 3.',`When you are done, write your report to ${rp}.`].join('\n\n');
const oc=env.KORA_HOME+'/tools/opencode/current/opencode';
const info=await c.call('agent.spawn',{agent:'opencode',cwd:dir,command:oc,args:['-m','opencode/big-pickle','--auto','--prompt',text],env:penv,name:'repro',worktree:false,skipWorkerPermission:true});
const id=info.id||info.paneId;const t0=Date.now();let last='';const out=[];
for(;;){const l=await c.call('pane.list',{});const p=l.panes.find(x=>x.id===id);const scr=(await c.call('pane.read',{paneId:id,source:'detection'})).text;
 const k=`${p&&p.state}`;const tail=scr.split('\n').filter(x=>x.trim()).slice(-10).join('\n');
 if(k!==last){out.push(`--- t=${((Date.now()-t0)/1000).toFixed(1)}s state=${k}\n${tail}`);last=k;}
 if(fs.existsSync(rp)||Date.now()-t0>100000){out.push(`END t=${((Date.now()-t0)/1000).toFixed(1)} report=${fs.existsSync(rp)} final:\n${tail}`);break;}
 await new Promise(r=>setTimeout(r,300));}
await c.call('pane.kill',{paneId:id}).catch(()=>{});fs.writeFileSync(process.argv[2],out.join('\n'));process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
