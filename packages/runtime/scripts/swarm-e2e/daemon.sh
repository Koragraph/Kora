#!/bin/bash
# start|stop|status the isolated e2e daemon
cd "$(dirname "$0")"
node -e '
const {childEnv,prepareHome,BIN,HOME}=require("./env.cjs");const {spawn,execFileSync}=require("child_process");const fs=require("fs");
const cmd=process.argv[1];
if(cmd==="start"){prepareHome();const out=fs.openSync(HOME+"/../daemon.out","a");const prof=process.env.PROF?["--cpu-prof","--cpu-prof-dir="+HOME+"/../prof"]:[];const p=spawn(process.execPath,[...prof,BIN,"server","run"],{env:childEnv(),detached:true,stdio:["ignore",out,out]});p.unref();console.log("started pid",p.pid);}
else{try{console.log(execFileSync(process.execPath,[BIN,"server",cmd],{env:childEnv(),encoding:"utf8"}))}catch(e){console.log(String(e.stdout||e.message))}}
' "$1"
