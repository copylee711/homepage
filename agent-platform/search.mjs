import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail } from './shared.mjs';
export const SEARCH_PRESETS = [
  { id:'baidu', name:'百度', kind:'baidu', enabled:true, useProxy:false },
  { id:'bing', name:'Bing', kind:'bing', enabled:true, useProxy:false },
  { id:'duckduckgo', name:'DuckDuckGo', kind:'duckduckgo', enabled:true, useProxy:true },
  { id:'deepseek', name:'DeepSeek Search', kind:'json', enabled:false, useProxy:false, endpoint:'https://api.deepseek.com/v1/tools/search', method:'POST', auth:'bearer', bodyTemplate:{query:'{{query}}',count:'{{count}}',need_content:false}, mapping:{results:'results',title:'title',url:'url',snippet:'summary'} },
];
export const SEARCH_DEFAULTS = { enabled:true, engine:'auto', language:'zh-CN', count:5 };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
export function normalizeSearch(value = {}, previous = {}) {
  if (!['zh-CN','en-US'].includes(value.language || 'zh-CN')) fail(422,'搜索语言无效');
  if (value.count !== undefined && (!Number.isInteger(value.count)||value.count<1||value.count>10)) fail(422,'结果数量需为 1–10');
  const input = value.sources || previous.sources || SEARCH_PRESETS;
  if (!Array.isArray(input)||input.length>10) fail(422,'搜索来源最多 10 个');
  const ids = new Set();
  const sources = input.map(source => {
    if (!plain(source)||!/^[a-z0-9_-]{1,40}$/.test(source.id||'')||ids.has(source.id)||['__proto__','constructor','prototype'].includes(source.id)) fail(422,'搜索来源标识无效或重复');
    ids.add(source.id);
    if (!['baidu','bing','duckduckgo','json'].includes(source.kind)) fail(422,'搜索类型无效');
    const result = {id:source.id,name:String(source.name||source.id).slice(0,60),kind:source.kind,enabled:source.enabled!==false,useProxy:source.useProxy===true};
    if(source.kind!=='json')return result;
    let url;try{url=new URL(source.endpoint);}catch{fail(422,'请输入完整的 HTTPS 搜索端点');}
    if(url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443')||source.endpoint.length>2048)fail(422,'搜索端点必须是无凭据的标准 HTTPS URL');
    const host=url.hostname.toLowerCase();
    if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||/^[\d.]+$/.test(host)||host.includes(':'))fail(422,'搜索端点不能是本地地址或 IP');
    const method=source.method||'POST',auth=source.auth||'none';
    if(!['GET','POST'].includes(method)||!['none','bearer','x-api-key'].includes(auth))fail(422,'搜索请求方式或认证无效');
    if(!plain(source.bodyTemplate)||JSON.stringify(source.bodyTemplate).length>8000)fail(422,'请求模板须为 JSON 对象，最多 8000 字符');
    const mapping=source.mapping||{results:'results',title:'title',url:'url',snippet:'snippet'};
    for(const key of ['results','title','url','snippet'])if(typeof mapping[key]!=='string'||mapping[key].length>200||!/^([A-Za-z0-9_]+\.)*[A-Za-z0-9_]*$/.test(mapping[key])||mapping[key].split('.').some(x=>['__proto__','constructor','prototype'].includes(x)))fail(422,'结果字段路径无效');
    const old=previous.sources?.find(x=>x.id===source.id);
    let apiKey=source.apiKey;
    if(apiKey===undefined||apiKey==='')apiKey=old?.endpoint===source.endpoint?old.apiKey||'':'';
    if(source.clearKey)apiKey='';
    if(typeof apiKey!=='string'||apiKey.length>2048||/[\r\n\x00]/.test(apiKey))fail(422,'API Key 无效');
    return {...result,endpoint:url.href,method,auth,bodyTemplate:source.bodyTemplate,mapping,apiKey};
  });
  const engine=value.engine||'auto';if(engine!=='auto'&&!ids.has(engine))fail(422,'首选搜索来源不存在');
  return {enabled:value.enabled!==false,engine,language:value.language||'zh-CN',count:value.count||5,sources};
}
export function publicSearch(config) { return {...config,sources:config.sources.map(({apiKey,...source})=>({...source,hasKey:!!apiKey}))}; }
export class SearchSettings {
  constructor(root='/data/search-settings'){this.root=root;this.queues=new Map();}
  file(user){if(!/^[a-f0-9]{64}$/.test(user))fail(422,'用户标识无效');return this.root+'/'+user+'.json';}
  async get(user){try{const config=JSON.parse(await readFile(this.file(user),'utf8'));return normalizeSearch(config,config);}catch(e){if(e.code==='ENOENT')return normalizeSearch();throw e;}}
  async save(user,value){const previous=this.queues.get(user)||Promise.resolve();const work=previous.catch(()=>{}).then(async()=>{const next=normalizeSearch(value,await this.get(user)),file=this.file(user);await mkdir(this.root,{recursive:true,mode:0o700});const temp=file+'.'+randomUUID();await writeFile(temp,JSON.stringify(next),{mode:0o600});await rename(temp,file);return publicSearch(next);});this.queues.set(user,work);try{return await work;}finally{if(this.queues.get(user)===work)this.queues.delete(user);}}
}
