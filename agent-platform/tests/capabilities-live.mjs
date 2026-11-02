// Opt-in protocol fixture + real model acceptance. Fixture is temporary public
// HTTPS, while all credentials below are synthetic test values.
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
const user=createHash('sha256').update('iris-acceptance-20261102').digest('hex');
const prefix=process.env.IRIS_QA_PREFIX;assert.match(prefix,/^qa-iris-[a-f0-9]{24}$/);
const endpoint='https://ai.copylee.cn/'+prefix;
const base='http://127.0.0.1:8081',headers={'Content-Type':'application/json','X-Runner-Secret':process.env.RUNNER_SECRET};
async function api(path,data={}){const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify({user,...data}),signal:AbortSignal.timeout(200000)});const v=await r.json();if(!r.ok)throw Object.assign(new Error(v.error),{status:r.status});return v;}
await api('/projects/create',{id:'qa-interactions',name:'验收'}).catch(e=>{if(e.status!==409)throw e;});
let config=await api('/features');assert.equal(config.skills.length,3);
config=await api('/features/save',{config:{...config,customSkills:[{id:'qa',description:'QA personal skill',content:'当用户说 QA_SKILL，请在完成用户的工具要求后，正文包含 SKILL_ORCHID。'}],mcpServers:[{id:'qa-json',name:'JSON MCP',url:endpoint+'/mcp',token:'iris-qa-private',enabled:true},{id:'qa-sse',name:'SSE MCP',url:endpoint+'/mcp-sse',token:'iris-qa-private',enabled:true}]}});
assert.ok(!JSON.stringify(config).includes('iris-qa-private'));
for(const id of ['qa-json','qa-sse']){config=await api('/features/mcp/test',{id});assert.equal(config.mcpServers.find(s=>s.id===id).tools[0].name,'echo');}
console.log('PASS: private remote MCP JSON and SSE initialize, keep session, discover tools; UI settings never echo token');
const searchConfig={enabled:true,engine:'custom',count:2,language:'zh-CN',sources:[{id:'custom',name:'HTTPS JSON fixture',kind:'json',enabled:true,endpoint:endpoint+'/search',method:'POST',auth:'bearer',apiKey:'iris-qa-private',bodyTemplate:{q:'{{query}}',n:'{{count}}'},mapping:{results:'data.hits',title:'label',url:'link',snippet:'summary'}}]};
const saved=await api('/search/settings/save',{config:searchConfig});assert.ok(!JSON.stringify(saved).includes('iris-qa-private'));
const result=await api('/search/test',{query:'custom query'});assert.equal(result.results[0].url,'https://docs.python.org/3/');assert.match(result.results[0].snippet,/custom query/);assert.ok(!JSON.stringify(result).includes('iris-qa-private'));
console.log('PASS: custom authenticated HTTPS search endpoint, query template, nested response mapping and key redaction');
await api('/search/settings/save',{config:{enabled:true,engine:'auto',sources:[{id:'baidu',name:'百度',kind:'baidu',enabled:true,useProxy:false}]}});
const thread=randomUUID();
const renewal=setInterval(()=>api('/renew').catch(()=>{}),5000);
try{
 const response=await fetch(base+'/prompt',{method:'POST',headers,body:JSON.stringify({user,thread,projectId:'qa-interactions',permission:{scope:'project_only',execution:'auto'},message:'/skill:personal-qa\nQA_SKILL。必须先调用任意一个 mcp_ 开头的 echo 工具，参数 text 为 MCP_PROOF；然后正文回复工具返回内容和技能标记。不要调用其他工具。'}),signal:AbortSignal.timeout(150000)});
 assert.ok(response.ok);const text=await response.text(),events=text.split('\n').filter(Boolean).map(l=>JSON.parse(l));
 assert.ok(events.some(e=>e.type==='tool_execution_end'&&e.toolName?.startsWith('mcp_')&&!e.isError));
 const body=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').flatMap(e=>e.message.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
 assert.match(body,/IRIS_MCP_OK/);assert.match(body,/SKILL_ORCHID/);
 console.log('PASS: real DeepSeek loads personal Skill and executes dynamically registered remote MCP tool');
}finally{clearInterval(renewal);}
// Seed canonical synthetic history beyond Pi's approximate recent-token window.
// Stop cached Pi first; never rewrite a live or real-user conversation.
await api('/cancel');
const {SessionManager}=await import('/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
const manager=SessionManager.open('/data/sessions/'+user+'/'+thread+'.jsonl');
for(let round=0;round<8;round++){
 manager.appendMessage({role:'user',content:[{type:'text',text:'合成压缩验收轮次 '+round+'\n'+('用于测试上下文压缩的合成记录。'.repeat(1050))}],timestamp:Date.now()});
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'确认'}],api:'openai-completions',provider:'opencode-go',model:'deepseek-v4.1-flash',usage:{input:0,output:1,cacheRead:0,cacheWrite:0,totalTokens:1,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()});
}
const before=(await api('/session',{thread})).messages.length;
const stats=await api('/context/stats',{thread});assert.ok(stats.totalMessages>0);
const compact=await api('/context/compact',{thread,instructions:'保留用户目标、工具结果和验收标记，简洁中文。'});assert.equal(compact.ok,true);
assert.ok(!compact.skipped,'fixture must be large enough for actual compaction');
assert.ok((await api('/session',{thread})).messages.length>=before);
console.log('PASS: real context stats and model compaction preserve original visible transcript');
