'use strict';
// Record an OpenCode swarm worker's start-up screens + detected states (the false-idle bug).
const fs=require('fs'),path=require('path'),os=require('os');const {execFileSync}=require('child_process');
const RT=require('path').resolve(__dirname,'../../dist');
const {Pane}=require(RT+'/server/pane.js');const {detect}=require(RT+'/detect/index.js');
const {swarmPaneEnv,writeOpencodePlugin}=require(RT+'/server/swarm-opencode.js');const {swarmWorkerPreamble}=require(RT+'/server/swarm-skill.js');
const OC=os.homedir()+'/.kora/tools/opencode/current/opencode';
const dir=fs.mkdtempSync(require('path').join(require('os').tmpdir(),'ocrep-'));const g=(...a)=>execFileSync('git',a,{cwd:dir,stdio:'ignore'});
g('init','-q');fs.writeFileSync(dir+'/README.md','# x\n');if(process.env.REPRO_FROM){for(const f of ['opencode.json','AGENTS.md'])fs.copyFileSync(process.env.REPRO_FROM+'/'+f,dir+'/'+f);}g('add','.');g('-c','user.email=t@t','-c','user.name=t','commit','-qm','i');
const rp=dir+'/.kora/swarm/s1.md';fs.mkdirSync(path.dirname(rp),{recursive:true});writeOpencodePlugin();
const meta={taskId:'s1',provider:'zen',model:'opencode/big-pickle',modelLabel:'big-pickle',phase:'starting',attempt:1,attempts:[],reportPath:rp,report:null,supersededBy:null,previousPaneIds:[],verify:null};
const env={...process.env,TERM:'xterm-256color',...swarmPaneEnv(meta,{apiKey:null,runtimeMode:'full-access'}),KORA_PANE_ID:'r1'};
const text=[swarmWorkerPreamble({reportPath:rp,taskId:'s1'}),'Create src/a.js exporting add(a,b). Check: node -e "import(\'./src/a.js\').then(m=>console.log(m.add(1,2)))" prints 3.',`When you are done, write your report to ${rp}.`].join('\n\n');
const pane=new Pane({id:'r1',workspaceId:'w',name:'oc',command:OC,args:['-m','opencode/big-pickle','--auto','--prompt',text],cwd:dir,agent:'opencode',env,cols:160,rows:45});
pane.spawn();const t0=Date.now();let last='',lastScreen='';const out=[];
const iv=setInterval(()=>{const s=pane.detectionSnapshot();const d=detect(s,'opencode');const k=`${d.state}:${d.ruleId}`;
 if(k!==last||(Date.now()-t0)%5000<300){out.push(`--- t=${((Date.now()-t0)/1000).toFixed(1)}s ${k}\n`+s.screen.split('\n').filter(l=>l.trim()).slice(-14).join('\n'));last=k;}
 if(fs.existsSync(rp)||Date.now()-t0>90000){clearInterval(iv);out.push(`END t=${((Date.now()-t0)/1000).toFixed(1)} report=${fs.existsSync(rp)}`);fs.writeFileSync(process.argv[2],out.join('\n'));pane.dispose();process.exit(0);}},300);
