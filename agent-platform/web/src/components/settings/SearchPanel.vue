<script setup lang="ts">
import { ref, onMounted, computed, onBeforeUnmount } from 'vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';
import SourceWikiPanel from './SourceWikiPanel.vue';
import SelectMenu from '../SelectMenu.vue';
const ui=useUi();
const category=ref('web'),showAll=ref(false);
const visibleSources=computed(()=>config.value.sources.map((source:any,index:number)=>({source,index})).filter(({source}:any)=>(source.category||'web')===category.value&&(showAll.value||source.enabled||source.hasKey||source.apiKey)));
const preferred=computed({get:()=>category.value==='image'?(config.value.imageEngine||'auto'):config.value.engine,set:(v:string)=>{if(category.value==='image')config.value.imageEngine=v;else config.value.engine=v;}});
const config=ref<any>({enabled:true,engine:'auto',language:'zh-CN',count:5,sources:[]});
const loading=ref(true),loaded=ref(false),saving=ref(false),error=ref(''),query=ref(''),testing=ref(false),results=ref<any>(null),editing=ref<any>(null),bodyText=ref(''),showKey=ref(false);
const savedConfig=ref('');
const wikiEditing=ref(false);
const dirty=computed(()=>wikiEditing.value || !!editing.value || (loaded.value && JSON.stringify(config.value)!==savedConfig.value));
async function leave(){return !dirty.value || await ui.confirm({title:'放弃未保存的搜索设置？',message:'搜索设置或目录中还有未保存的修改。',confirmText:'放弃修改',cancelText:'继续编辑',danger:true});}
function beforeUnload(e:BeforeUnloadEvent){if(dirty.value){e.preventDefault();e.returnValue='';}}
const engines=computed(()=>[{value:'auto',label:'按下方顺序自动回退'},...config.value.sources.filter((s:any)=>(s.category||'web')===category.value).map((s:any)=>({value:s.id,label:s.name}))]);
async function changeCategory(id:string){if(editing.value&&!await ui.confirm({title:'放弃正在编辑的来源？',message:'来源编辑尚未应用，其他已应用的设置会保留。',confirmText:'放弃编辑',cancelText:'继续编辑'}))return;category.value=id;results.value=null;editing.value=null;showAll.value=false;}
async function load(){loading.value=true;error.value='';try{config.value=await get('/api/search/settings');savedConfig.value=JSON.stringify(config.value);loaded.value=true;}catch(e:any){error.value=e.message;}finally{loading.value=false;}}
onMounted(()=>{ui.dialogGuard=leave;window.addEventListener('beforeunload',beforeUnload);void load();});
onBeforeUnmount(()=>{if(ui.dialogGuard===leave)ui.dialogGuard=null;window.removeEventListener('beforeunload',beforeUnload);});
async function save(){if(editing.value){error.value='请先应用或取消正在编辑的来源';return;}saving.value=true;error.value='';try{config.value=await post('/api/search/settings/save',{config:config.value});savedConfig.value=JSON.stringify(config.value);ui.toast('搜索设置已保存',{tone:'success'});}catch(e:any){error.value=e.message;}finally{saving.value=false;}}
async function test(){testing.value=true;error.value='';results.value=null;try{results.value=await post('/api/search/test',{query:query.value.trim(),category:category.value,source:preferred.value==='auto'?undefined:preferred.value});}catch(e:any){error.value=e.message;}finally{testing.value=false;}}
function edit(source:any){editing.value=JSON.parse(JSON.stringify(source));editing.value.apiKey='';bodyText.value=JSON.stringify(source.bodyTemplate||{query:'{{query}}',count:'{{count}}'},null,2);showKey.value=false;error.value='';}
function add(){edit({id:'custom-'+crypto.randomUUID().slice(0,8),name:category.value==='image'?'自定义图片搜索':'自定义搜索',category:category.value,kind:'json',enabled:true,useProxy:false,endpoint:'',method:'POST',auth:'bearer',bodyTemplate:{query:'{{query}}',count:'{{count}}'},mapping:{results:'results',title:'title',url:'url',snippet:'snippet'}});}
function apply(){try{const source={...editing.value,bodyTemplate:JSON.parse(bodyText.value)};if(!source.endpoint||!source.name)throw Error('请填写名称和完整端点');const idx=config.value.sources.findIndex((s:any)=>s.id===source.id);if(idx<0)config.value.sources.push(source);else config.value.sources[idx]=source;editing.value=null;error.value='';}catch(e:any){error.value=e.message||'请求模板不是有效 JSON';}}
function move(index:number,offset:number){const list=config.value.sources;[list[index],list[index+offset]]=[list[index+offset],list[index]];}
async function remove(source:any){if(!await ui.confirm({title:'移除搜索来源',message:'保存后将移除“'+source.name+'”及其密钥。',confirmText:'移除',danger:true}))return;config.value.sources=config.value.sources.filter((s:any)=>s.id!==source.id);if(config.value.engine===source.id)config.value.engine='auto';if(config.value.imageEngine===source.id)config.value.imageEngine='auto';}
</script>
<template>
<div class="settings-pad search-settings">
<p v-if="loading" role="status">正在读取搜索设置…</p>
<template v-else-if="loaded">
<h3>联网搜索</h3><p class="question-hint">无需 Pi 搜索插件。来源失败、限流或未配置密钥时按顺序回退。API Key 只保存在服务端，不会提供给 Agent；配置仅对当前账户生效。</p>
<div class="setting-row"><label for="search-enabled">允许 Agent 联网搜索</label><input id="search-enabled" v-model="config.enabled" type="checkbox" :disabled="saving" /></div>
<SourceWikiPanel @editing="wikiEditing=$event" />
<div class="seg" role="group" aria-label="搜索类型"><button v-for="[id,name] in [['web','网页搜索'],['image','图片搜索']]" :key="id" type="button" :class="{'is-on':category===id}" :aria-pressed="category===id" @click="changeCategory(id)">{{name}}</button></div>
<div class="setting-row"><span>首选来源</span><SelectMenu v-model="preferred" :options="engines" aria-label="首选搜索来源" :disabled="saving" /></div>
<div class="setting-row"><span>结果语言</span><div class="seg"><button v-for="[id,name] in [['zh-CN','中文'],['en-US','English']]" :key="id" type="button" :class="{'is-on':config.language===id}" :aria-pressed="config.language===id" @click="config.language=id">{{name}}</button></div></div>
<div class="setting-row"><label for="search-count">默认结果数（1–10）</label><input id="search-count" v-model.number="config.count" type="number" min="1" max="10" /></div>
<h4>来源与回退顺序</h4><p class="question-hint">“使用服务器代理”只使用管理员已配置的出口；国内来源通常直连更稳定。带 API Key 的来源可能按次计费。</p>
<div v-for="{source,index:i} in visibleSources" :key="source.id" class="search-source-row">
  <div class="search-source-name"><label><input v-model="source.enabled" type="checkbox" /> {{source.name}}</label><small>{{source.kind==='json'?(source.hasKey||source.apiKey?'已配置密钥':source.auth==='none'?'无需密钥':source.auth==='optional-bearer'?'密钥可选':'未配置密钥'):'免费网页搜索'}}</small></div>
  <label class="question-hint"><input v-model="source.useProxy" type="checkbox" /> 使用服务器代理</label>
  <div class="search-source-actions"><button type="button" class="btn btn-quiet btn-sm" :disabled="i===0" :aria-label="'上移 '+source.name" @click="move(Number(i),-1)">↑</button><button type="button" class="btn btn-quiet btn-sm" :disabled="i===config.sources.length-1" :aria-label="'下移 '+source.name" @click="move(Number(i),1)">↓</button><button v-if="source.kind==='json'" type="button" class="btn btn-quiet btn-sm" @click="edit(source)">配置</button><button type="button" class="btn btn-quiet btn-sm" :aria-label="'移除 '+source.name" @click="remove(source)">移除</button></div>
</div>
<button type="button" class="btn btn-quiet" @click="showAll=!showAll">{{showAll?'收起未启用来源':'显示全部预设来源'}}</button>
<button type="button" class="btn btn-quiet" :disabled="config.sources.length>=48 || !!editing" @click="add">添加自定义 JSON 搜索来源</button>
<section v-if="editing" class="search-source-editor" aria-label="配置搜索来源"><h4>{{editing.name}}</h4><p class="question-hint">填写最终 HTTPS 端点；修改端点会清除旧密钥。DNS、私网地址和重定向会经过校验。请求模板支持 <code v-pre>{{query}}</code>、<code v-pre>{{count}}</code>、<code v-pre>{{language}}</code>；字段映射使用点路径（如 data.results），留空表示根对象。</p>
<label for="source-name">来源名称</label><input id="source-name" v-model="editing.name" maxlength="60" />
<label for="source-endpoint">完整 HTTPS 端点</label><input id="source-endpoint" v-model="editing.endpoint" type="url" placeholder="https://api.example.com/search" maxlength="2048" />
<div class="search-source-selects"><span>请求方式</span><SelectMenu v-model="editing.method" :options="[{value:'POST',label:'POST JSON'},{value:'GET',label:'GET 查询参数'}]" aria-label="搜索 API 请求方式" /><span>认证方式</span><SelectMenu v-model="editing.auth" :options="[{value:'none',label:'无需认证'},{value:'bearer',label:'Bearer Token'},{value:'x-api-key',label:'X-API-Key'},{value:'optional-bearer',label:'Bearer（密钥可选）'},{value:'x-goog-api-key',label:'Google API Key'},{value:'raw-authorization',label:'Authorization 原值'},{value:'client-id',label:'Unsplash Client-ID'},{value:'query-key',label:'Pixabay 查询密钥'}]" aria-label="搜索 API 认证方式" /></div>
<label for="source-key">API Key {{editing.hasKey?'（已保存，留空保持）':''}}</label><div class="search-key"><input id="source-key" v-model="editing.apiKey" :type="showKey?'text':'password'" autocomplete="new-password" spellcheck="false" /><button type="button" class="btn btn-quiet" :aria-label="showKey?'隐藏密钥':'显示密钥'" @click="showKey=!showKey">{{showKey?'隐藏':'显示'}}</button></div><label v-if="editing.hasKey" class="question-hint"><input v-model="editing.clearKey" type="checkbox" /> 清除已保存的密钥</label>
<label for="source-body">JSON 请求模板</label><textarea id="source-body" v-model="bodyText" rows="6" style="resize: none" spellcheck="false"></textarea>
<div class="search-mapping"><label v-for="[key,label] in [['results','结果数组'],['title','标题'],['url','链接'],['snippet','摘要']]" :key="key">{{label}}字段<input v-model="editing.mapping[key]" :aria-label="label+'字段路径'" maxlength="200" /></label></div>
<div class="approval-actions"><button type="button" class="btn btn-quiet" @click="editing=null">取消编辑</button><button type="button" class="btn btn-solid" @click="apply">应用来源配置</button></div></section>
<div class="approval-actions"><button type="button" class="btn btn-solid" :disabled="saving || !!editing" @click="save">{{saving?'保存中…':'保存搜索设置'}}</button></div>
<form novalidate class="search-test" @submit.prevent="test"><label for="search-test">测试已保存的搜索配置</label><div class="search-test-input"><input id="search-test" v-model="query" maxlength="500" placeholder="输入关键词" /><button v-if="query" type="button" class="btn btn-quiet" aria-label="清空搜索词" @click="query='';results=null">清空</button><button type="submit" class="btn btn-quiet" :disabled="testing || !query.trim()">{{testing?'搜索中…':'测试搜索'}}</button></div></form>
<div v-if="results" aria-live="polite"><p class="question-hint">使用 {{results.engine}} · {{results.results.length}} 条结果</p><div v-if="results.images" class="search-image-grid"><figure v-for="image in results.images" :key="image.url"><a :href="image.sourceUrl||image.url" target="_blank" rel="noopener noreferrer"><img :src="'/api/image?url='+encodeURIComponent(image.thumbnail||image.url)" :alt="image.title" loading="lazy" /></a><figcaption>{{image.title}} · {{image.author}} · {{image.license}}</figcaption></figure></div><p v-for="item in (results.images?[]:results.results)" :key="item.url"><a :href="item.url" target="_blank" rel="noopener noreferrer">{{item.title}}</a><span class="question-hint">{{item.snippet}}</span></p></div>
</template>
<p v-if="error" class="status-error" role="alert">{{error}} <button v-if="!loaded && !loading" type="button" class="btn btn-quiet" @click="load">重新读取设置</button></p>
</div>
</template>
<style>
.search-image-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.search-image-grid figure{margin:0;min-width:0}.search-image-grid img{width:100%;height:140px;object-fit:cover;border-radius:8px}.search-image-grid figcaption{font-size:11px;color:var(--muted);overflow-wrap:anywhere}
.search-test { margin:24px 0 14px;padding-top:16px;border-top:1px solid var(--line); }
.search-test-input,.search-key { display:flex;flex-wrap:wrap;gap:8px;margin-top:8px; }
.search-settings input:not([type='checkbox']),.search-settings textarea { min-width:0;padding:8px 10px;border:1px solid var(--line-strong);border-radius:var(--radius-xs);background:var(--surface); }
.search-test input,.search-key input { min-width:120px!important;flex:1; }
.search-source-row { padding:12px 0;border-bottom:1px solid var(--line); }
.search-source-name { display:flex;gap:12px;align-items:center;justify-content:space-between;font-size:13px; }
.search-source-name label,.search-source-row .question-hint { display:flex;gap:6px;align-items:center; }
.search-source-name small { color:var(--muted); }
.search-source-actions { display:flex;gap:6px;justify-content:flex-end; }
.search-source-editor { margin-top:18px;padding:14px;border:1px solid var(--line-strong);border-radius:var(--radius-sm); }
.search-source-editor>label { display:block;font-size:12px;margin:12px 0 4px; }
.search-source-editor>input,.search-source-editor>textarea { width:100%; }
.search-source-selects { display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:14px 0;font-size:12px; }
.search-mapping { display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;font-size:12px; }
.search-mapping input { display:block;width:100%; }
</style>
