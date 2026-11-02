import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FeatureStore,publicFeatures,mcpToolName } from '../features.mjs';
import { McpConnections } from '../mcp.mjs';
test('built-in skills load by default, personal files are private and MCP keys masked',async()=>{
 const root=await mkdtemp(join(tmpdir(),'iris-features-')),user='a'.repeat(64);
 try{
  const store=new FeatureStore(root),initial=await store.get(user);assert.equal(initial.skills.length,3);
  const next=await store.save(user,{...initial,customSkills:[{id:'qa',description:'QA skill',content:'SKILL_MARKER'}],mcpServers:[{id:'qa',url:'https://example.com/mcp',token:'secret-token',enabled:true}]});
  assert.ok(!JSON.stringify(next).includes('secret-token'));assert.equal(next.mcpServers[0].hasToken,true);
  const files=await store.skills(user);assert.equal(files.files.length,4);assert.match(await readFile(files.files[3],'utf8'),/SKILL_MARKER/);
  await assert.rejects(store.save(user,{...initial}),e=>e.status===409);
  const raw=await store.get(user);assert.equal(raw.mcpServers[0].token,'secret-token');assert.equal((await store.get('b'.repeat(64))).mcpServers.length,0);
  assert.ok(mcpToolName('qa','weird.tool-name').length<64);
  await assert.rejects(store.save(user,{...raw,mcpServers:[{id:'qa',url:'http://localhost/mcp'}]}));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('MCP initializes once and carries session/protocol through tool listing and calls',async()=>{
 const requests=[];
 const client=new McpConnections(async value=>{requests.push(value);const method=value.message.method;if(method==='initialize')return {session:'session-one',value:{result:{protocolVersion:'2025-03-26'}}};if(method==='tools/list')return {value:{result:{tools:[{name:'echo',inputSchema:{type:'object'}}]}}};if(method==='tools/call')return {value:{result:{content:[{type:'text',text:'real result'}]}}};return {};});
 const server={id:'one',name:'One',url:'https://example.com/mcp',token:'secret'};
 assert.equal((await client.tools(server))[0].name,'echo');assert.equal((await client.call(server,'echo',{})).text,'real result');
 assert.deepEqual(requests.map(r=>r.message.method),['initialize','notifications/initialized','tools/list','tools/call']);
 assert.equal(requests[3].session,'session-one');assert.equal(requests[3].protocol,'2025-03-26');
});
