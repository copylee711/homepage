<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { get, post } from '../../services/api';
import { useUi } from '../../stores/ui';
const ui=useUi(),tasks=ref<any[]>([]),loading=ref(true),error=ref(''),pending=ref(''),logs=ref<Record<string,string>>({});
let timer:ReturnType<typeof setTimeout>|undefined,disposed=false;
async function load(){if(timer)clearTimeout(timer);try{const r=await get('/api/background');if(disposed)return;tasks.value=r.tasks||[];error.value='';}catch(e:any){if(!disposed)error.value=e.message;}finally{loading.value=false;if(!disposed)timer=setTimeout(load,4000);}}
async function readLogs(id:string){pending.value=id;try{const r=await get('/api/background?id='+encodeURIComponent(id));logs.value[id]=r.logs||'暂无日志';}catch(e:any){error.value=e.message;}finally{pending.value='';}}
async function stop(task:any){if(!await ui.confirm({title:'停止后台任务',message:`停止“${task.title}”后，预览链接立即失效。项目文件会保留。`,confirmText:'停止任务'}))return;pending.value=task.id;try{await post('/api/background/stop',{id:task.id});await load();}catch(e:any){error.value=e.message;}finally{pending.value='';}}
onMounted(load);onBeforeUnmount(()=>{disposed=true;if(timer)clearTimeout(timer);});
</script>
<template><div class="settings-pad"><h3>后台任务</h3><p class="question-hint">可让 Iris 启动 Vite 等预览服务。每个账户最多 2 个任务，单个任务最多运行 1 小时，关闭对话后继续运行。预览为私密临时链接，请勿转发；支持 HTTP，暂不转发 WebSocket，代码修改后请刷新页面。</p><p v-if="loading" role="status">正在读取后台任务…</p><p v-else-if="!tasks.length" class="question-hint">暂无后台任务。可以对 Iris 说“启动这个项目的 Vite 预览”。</p><section v-for="task in tasks" :key="task.id" class="background-task"><div class="background-task-head"><strong>{{ task.title }}</strong><span>{{ task.state==='running'?'运行中':task.state==='exited'?'已退出（'+task.exitCode+'）':'已停止' }}</span></div><code>{{ task.command }}</code><p class="question-hint">{{ task.cwd }} · 最迟 {{ new Date(task.expiresAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) }} 停止</p><div class="background-actions"><a v-if="task.previewPath && task.state==='running'" :href="task.previewPath" target="_blank" rel="noopener noreferrer" class="btn btn-quiet">打开预览</a><button type="button" class="btn btn-quiet" :disabled="!!pending" @click="readLogs(task.id)">查看日志</button><button v-if="task.state==='running'" type="button" class="btn btn-quiet" :disabled="!!pending" @click="stop(task)">停止任务</button></div><pre v-if="logs[task.id]" class="background-logs">{{ logs[task.id] }}</pre></section><p v-if="error" class="status-error" role="alert">{{ error }} <button type="button" class="btn btn-quiet" @click="load">重试</button></p></div></template>
<style>
.background-task { padding: 14px 0; border-bottom: 1px solid var(--line); }
.background-task-head { display:flex;justify-content:space-between;gap:12px;font-size:13px;margin-bottom:6px; }
.background-task-head span { color:var(--muted); }
.background-task code { display:block;overflow-wrap:anywhere;font-size:12px;white-space:pre-wrap; }
.background-actions { display:flex;gap:8px;flex-wrap:wrap; }
.background-logs { max-height:280px;overflow:auto;padding:10px;background:var(--code-bg);white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px; }
</style>
