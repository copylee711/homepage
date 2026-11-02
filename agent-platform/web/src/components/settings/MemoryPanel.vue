<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import SelectMenu from '../SelectMenu.vue';
import { useSession } from '../../stores/session';
import { useUi } from '../../stores/ui';
import { get, post } from '../../services/api';
const session = useSession(), ui = useUi();
const project = ref(session.currentProjectId), revision = ref(0), loading = ref(true), loaded = ref(false), saving = ref(''), error = ref('');
const draft = ref({persona:'',global:'',project:''}), saved = ref({persona:'',global:'',project:''});
const dirty = computed(()=>JSON.stringify(draft.value)!==JSON.stringify(saved.value));
const fields = [{id:'persona' as const,label:'账户人设',hint:'称呼、角色与回答风格，适用于所有项目。最多 4000 字。',max:4000},{id:'global' as const,label:'全局记忆',hint:'跨项目通用的稳定偏好。最多 16000 字。',max:16000},{id:'project' as const,label:'项目记忆',hint:'仅在所选项目作为主项目时加载。最多 16000 字。',max:16000}];
async function load() { loading.value=true; error.value=''; try {const m=await get('/api/memory?project='+encodeURIComponent(project.value));revision.value=m.revision;draft.value={persona:m.persona,global:m.global,project:m.project};saved.value={...draft.value};loaded.value=true;}catch(e:any){error.value=e.message;}finally{loading.value=false;} }
async function leave() { if(saving.value) return false; return !dirty.value || await ui.confirm({title:'放弃未保存的记忆修改？',message:'当前修改尚未保存，离开后会丢失。',confirmText:'放弃修改',cancelText:'继续编辑',danger:true}); }
async function changeProject(value: string|number) { if(!await leave()) return; project.value=String(value);await load(); }
async function save(scope:'persona'|'global'|'project', clear=false) {
  if(saving.value)return;
  if(clear && !await ui.confirm({title:'清除'+fields.find(f=>f.id===scope)!.label,message:'将删除已保存的这层内容，下次对话不再加载。',confirmText:'清除',danger:true}))return;
  saving.value=scope;error.value='';try{const m=await post('/api/memory/update',{project:project.value,scope,action:clear?'clear':'replace',content:draft.value[scope],revision:revision.value});revision.value=m.revision;draft.value[scope]=m[scope];saved.value[scope]=m[scope];ui.toast('已保存，下次模型处理任务时加载',{tone:'success'});}catch(e:any){error.value=e.message;}finally{saving.value='';}
}
function beforeUnload(e:BeforeUnloadEvent){if(dirty.value){e.preventDefault();e.returnValue='';}}
onMounted(()=>{ui.dialogGuard=leave;window.addEventListener('beforeunload',beforeUnload);void load();});
onBeforeUnmount(()=>{if(ui.dialogGuard===leave)ui.dialogGuard=null;window.removeEventListener('beforeunload',beforeUnload);});
</script>
<template>
  <div class="settings-pad memory-settings">
    <h3>人设与记忆</h3><p class="question-hint">内容仅属于当前账户。可以在这里编辑，也可以在对话中明确让 Iris 记住偏好或修改人设。人设不会改变工具审批和项目隔离。</p>
    <div class="setting-row"><span>当前记忆项目</span><SelectMenu :model-value="project" :options="session.projects.map(p=>({value:p.id,label:p.name}))" aria-label="记忆所属项目" :disabled="!!saving" @update:model-value="changeProject" /></div>
    <p v-if="loading" role="status">正在读取人设与记忆…</p>
    <template v-else-if="loaded"><section v-for="field in fields" :key="field.id" class="memory-field"><label :for="'memory-'+field.id">{{ field.label }}</label><p class="question-hint">{{ field.hint }}</p><textarea :id="'memory-'+field.id" v-model="draft[field.id]" :maxlength="field.max" rows="5" style="resize: none" :disabled="!!saving" :aria-describedby="'memory-size-'+field.id"></textarea><div class="memory-footer"><small :id="'memory-size-'+field.id">{{ draft[field.id].length }}/{{ field.max }}{{ draft[field.id]!==saved[field.id]?' · 未保存':'' }}</small><button type="button" class="btn btn-quiet" :disabled="!!saving || !saved[field.id]" @click="save(field.id,true)">清除</button><button type="button" class="btn btn-solid" :disabled="!!saving || draft[field.id]===saved[field.id]" @click="save(field.id)">{{ saving===field.id?'保存中…':'保存' }}</button></div></section></template>
    <p v-if="error" class="status-error" role="alert">{{ error }} <button type="button" class="btn btn-quiet" :disabled="!!saving" @click="leave().then(ok=>ok&&load())">重新读取</button></p>
  </div>
</template>
<style>
.memory-field { margin: 20px 0; }
.memory-field label { font-weight: 600; font-size: 14px; }
.memory-field textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--surface); line-height: 1.6; }
.memory-footer { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.memory-footer small { flex: 1; color: var(--muted); }
</style>
