import { randomUUID } from 'node:crypto';
import { fail } from './shared.mjs';
export class McpConnections {
 constructor(request){this.request=request;this.sessions=new Map();}
 async rpc(server,method,params,notification=false){
   const state=this.sessions.get(server.id)||{};
   const result=await this.request({op:'mcp-request',endpoint:server.url,token:server.token||'',useProxy:server.useProxy,session:state.session,protocol:state.protocol,message:{jsonrpc:'2.0',...(notification?{}:{id:randomUUID()}),method,...(params?{params}:{})}});
   if(result.session)state.session=result.session;
   if(result.value?.result?.protocolVersion)state.protocol=result.value.result.protocolVersion;
   this.sessions.set(server.id,state);
   if(result.value?.error)fail(502,'MCP '+server.name+' 返回协议错误（'+String(result.value.error.code||'unknown')+'）');
   return result.value?.result;
 }
 async initialize(server){if(this.sessions.get(server.id)?.ready)return;await this.rpc(server,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'Iris',version:'1.0.0'}});await this.rpc(server,'notifications/initialized',undefined,true);this.sessions.get(server.id).ready=true;}
 async tools(server){await this.initialize(server);const result=await this.rpc(server,'tools/list',{});if(!Array.isArray(result?.tools))fail(502,'MCP 没有返回工具列表');if(result.tools.length>64)fail(422,'此服务提供超过 64 个工具，请在 MCP 服务端缩小暴露范围');return result.tools.map(tool=>{if(!/^[A-Za-z0-9_.-]{1,100}$/.test(tool.name||'')||!tool.inputSchema||JSON.stringify(tool.inputSchema).length>16000)fail(502,'MCP 工具定义无效');return {name:tool.name,description:String(tool.description||tool.name).slice(0,1500),inputSchema:tool.inputSchema};});}
 async call(server,name,args){await this.initialize(server);const result=await this.rpc(server,'tools/call',{name,arguments:args});const text=(result?.content||[]).filter(c=>c.type==='text').map(c=>String(c.text||'')).join('\n').slice(0,50000);return {text,isError:result?.isError===true};}
}
