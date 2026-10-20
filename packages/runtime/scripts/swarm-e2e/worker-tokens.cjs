// Per worker session (swarm e2e worktrees): sum assistant-message tokens → real cost inputs.
const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.env.HOME+"/.local/share/opencode/opencode.db",{readOnly:true});
const sessions=db.prepare("select id, directory from session where parent_id is null and directory like '%/worktrees/%'").all();
const rows=[];
for(const s of sessions){
  let inp=0,out=0,cr=0,cw=0,reason=0,msgs=0,model='';
  for(const m of db.prepare("select data from message where session_id=?").all(s.id)){
    const d=JSON.parse(m.data); if(d.role!=='assistant') continue; msgs++;
    const t=d.tokens||{}; inp+=t.input||0; out+=t.output||0; reason+=t.reasoning||0; cr+=(t.cache&&t.cache.read)||0; cw+=(t.cache&&t.cache.write)||0; model=d.modelID||model;
  }
  if(msgs) rows.push({msgs,inp,out,reason,cr,cw,model});
}
const med=(a)=>{a=[...a].sort((x,y)=>x-y);return a[Math.floor(a.length/2)]};const p90=(a)=>{a=[...a].sort((x,y)=>x-y);return a[Math.floor(a.length*0.9)]};
const tot=(r)=>r.inp+r.cr+r.cw;
console.log('worker sessions:',rows.length);
for(const [k,f] of [['requests (assistant msgs)',r=>r.msgs],['fresh input tok',r=>r.inp],['cache-read tok',r=>r.cr],['total input tok',tot],['output+reasoning tok',r=>r.out+r.reason]]) console.log(k.padEnd(26),'median',med(rows.map(f)),' p90',p90(rows.map(f)));
