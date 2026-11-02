// Opt-in synthetic-user acceptance against the deployed sandbox and real model.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { sandbox, sandboxTool } from '/app/sandbox-client.mjs';
const user=createHash('sha256').update('iris-acceptance-20261102').digest('hex');
const base='http://127.0.0.1:8081',headers={'Content-Type':'application/json','X-Runner-Secret':process.env.RUNNER_SECRET};
async function api(path,data={}){const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify({user,...data}),signal:AbortSignal.timeout(180000)});const value=await r.json();if(!r.ok)throw Object.assign(new Error(value.error),{status:r.status});return value;}
for(const id of ['qa-interactions','qa-memory-other'])await api('/projects/create',{id,name:id}).catch(e=>{if(e.status!==409)throw e;});
await api('/memory/update',{project:'qa-interactions',scope:'persona',action:'replace',content:'你叫小鸢。称呼用户为验收员，简洁中文回答。'});
await api('/memory/update',{project:'qa-interactions',scope:'global',action:'replace',content:'全局测试标记 GLOBAL_ORCHID。'});
await api('/memory/update',{project:'qa-interactions',scope:'project',action:'replace',content:'项目测试标记 PROJECT_IRIS。'});
assert.equal((await api('/memory',{project:'qa-memory-other'})).project,'');
assert.equal((await api('/memory',{user:'b'.repeat(64),project:'default'})).global,'');
console.log('PASS: global/persona/project memory isolates users and other projects');
async function prompt(message, mode='auto'){
 const renewal=setInterval(()=>api('/renew').catch(()=>{}),5000);
 try{const r=await fetch(base+'/prompt',{method:'POST',headers,body:JSON.stringify({user,thread:randomUUID(),projectId:'qa-interactions',permission:{scope:'project_only',execution:mode},message}),signal:AbortSignal.timeout(150000)});assert.ok(r.ok);const text=await r.text();assert.match(text,/agent_settled/);assert.doesNotMatch(text,/"type":"gateway_error"/);return text.split('\n').filter(Boolean).map(l=>JSON.parse(l));}finally{clearInterval(renewal);await api('/cancel').catch(()=>{});}
}
const memoryEvents=await prompt('验收：先调用 memory_read 确认记忆；然后调用 memory_update 在项目记忆追加“用户明确要求记住：包管理器为 pnpm”。最后正文告诉我你的名字、我的称呼、全局标记和项目标记。必须执行，不要写工作区文件。','edit');
assert.ok(memoryEvents.some(e=>e.type==='tool_execution_end'&&e.toolName==='memory_update'&&!e.isError));
assert.match((await api('/memory',{project:'qa-interactions'})).project,/pnpm/);
const finalText=memoryEvents.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').flatMap(e=>e.message.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
for(const marker of ['小鸢','验收员','GLOBAL_ORCHID','PROJECT_IRIS'])assert.match(finalText,new RegExp(marker));
console.log('PASS: real model follows saved persona/context and writes project memory through tool');

const lease=(await sandbox('/lease',user,undefined,{project:'qa-interactions',scope:'project_only'})).token;
await sandboxTool(lease,{op:'write',path:'/workspace/qa-interactions/index.html',content:'<!doctype html><html><body><h1>IRIS_BACKGROUND_OK</h1></body></html>'});
const events=await prompt('验收后台任务：只调用 background_start，command 为 python3 -u -m http.server 5173 --bind 127.0.0.1，port 为 5173，title 为 QA HTTP Preview。然后调用 background_status 确认运行，最后回复启动完成。不要停止任务，不要使用 bash。');
assert.ok(events.some(e=>e.type==='tool_execution_end'&&e.toolName==='background_start'&&!e.isError));
let tasks=(await api('/background/list')).tasks,task=tasks.find(t=>t.state==='running');assert.ok(task);
const preview=await api('/background/preview',{token:task.id,path:'/'});
assert.match(Buffer.from(preview.data,'base64').toString(),/IRIS_BACKGROUND_OK/);
await assert.rejects(api('/background/stop',{user:'b'.repeat(64),id:task.id}));
const logs=await api('/background/list',{id:task.id});assert.match(logs.logs,/Serving HTTP/);
await api('/background/stop',{id:task.id});
await assert.rejects(api('/background/preview',{token:task.id,path:'/'}));
console.log('PASS: real model starts isolated persistent HTTP task; preview/logs work after turn; cross-user stop blocked; stopped preview invalid');

// Real Vite preview: install into synthetic workspace, with a one-hour bounded
// container. It is left running only for the browser preview isolation check.
const token=(await sandbox('/lease',user,undefined,{project:'qa-interactions',scope:'project_only'})).token;
const renewal=setInterval(()=>sandbox('/renew',user,token).catch(()=>{}),5000);
try{
 const install=await sandboxTool(token,{op:'bash',cwd:'/workspace/qa-interactions',command:'test -f node_modules/vite/bin/vite.js || npm install --https-proxy=http://192.168.85.2:3128 --legacy-peer-deps --no-audit --no-fund --save-dev vite@6.4.5 --fetch-retries=1 --fetch-timeout=10000 --cache .npm-cache',timeout:150},170000);
 assert.equal(install.exitCode,0,'Vite fixture must install');
 await sandboxTool(token,{op:'write',path:'/workspace/qa-interactions/index.html',content:'<!doctype html><html><body><h1>IRIS_VITE_PREVIEW</h1><script type="module" src="./main.js"></script></body></html>'});
 await sandboxTool(token,{op:'write',path:'/workspace/qa-interactions/main.js',content:'document.body.dataset.module="loaded";try{document.body.dataset.isolation=localStorage.getItem("iris-test-secret")||"readable"}catch{document.body.dataset.isolation="opaque"}'});
 await sandboxTool(token,{op:'write',path:'/workspace/qa-interactions/vite.config.mjs',content:'export default {server:{hmr:false,strictPort:true}}'});
 const vite=await sandboxTool(token,{op:'background-start',cwd:'/workspace/qa-interactions',title:'QA Vite Preview',command:'./node_modules/.bin/vite --host 0.0.0.0 --port 5173 --base "$IRIS_PREVIEW_BASE"',port:5173,previewBase:true});
 let ready=false;
 for(let i=0;i<15;i++){try{const r=await api('/background/preview',{token:vite.id,path:'/'});if(Buffer.from(r.data,'base64').toString().includes('IRIS_VITE_PREVIEW')){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
 assert.ok(ready,'Vite preview should become ready');
 await writeFile('/tmp/iris-live-preview-path',vite.previewPath);
 console.log('PASS: real Vite installs, starts in background and serves HTTP with private preview base');
}finally{clearInterval(renewal);}
