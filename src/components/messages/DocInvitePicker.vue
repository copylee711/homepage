<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { docsApi, roleName } from '../../docs'
import type { DocItem } from '../../docs'
import DriveDialog from '../drive/DriveDialog.vue'
import MenuSelect from '../MenuSelect.vue'

/** 选一篇自己能分享的文档和授予的权限，作为协作邀请发给好友；对方接受后成为文档成员。 */
const props = defineProps<{ name: string }>()
const emit = defineEmits<{ close: []; pick: [invite: { doc_id: string; role: 'view' | 'edit'; can_share: boolean }] }>()
const docs = ref<DocItem[]>([])
const selected = ref(''), role = ref<'view' | 'edit'>('edit'), canShare = ref(false)
const loading = ref(true), error = ref('')

const doc = computed(() => docs.value.find(item => item.id === selected.value))
// 非所有者只能授予不超过自己的权限。
const roleOptions = computed(() => (doc.value?.role === 'view' ? ['view'] : ['view', 'edit']).map(value => ({ value, label: roleName[value]! })))

function select(item: DocItem) {
  selected.value = item.id
  if (item.role === 'view') role.value = 'view'
}

onMounted(async () => {
  try {
    const data = await docsApi<{ owned: DocItem[]; shared: DocItem[] }>('')
    docs.value = [...data.owned, ...data.shared.filter(item => item.can_share)]
  } catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
  finally { loading.value = false }
})
</script>

<template>
  <DriveDialog :title="`邀请 ${props.name} 协作`" @close="emit('close')">
    <p class="d-muted intro">对方接受后成为文档成员。只列出你有分享权限的文档。</p>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <p v-else-if="loading" class="d-muted empty">正在读取…</p>
    <p v-else-if="!docs.length" class="d-muted empty">还没有可以分享的文档。</p>
    <ul v-else class="docs" role="radiogroup" aria-label="文档">
      <li v-for="item in docs" :key="item.id">
        <button type="button" role="radio" :aria-checked="selected === item.id" :class="{ on: selected === item.id }" @click="select(item)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20V3.5ZM14 3.5V8h4M10 12h5M10 15.5h5" /></svg>
          <span class="title">{{ item.title }}</span>
          <small>{{ item.role === 'owner' ? '我的' : `${item.owner?.name} · ${roleName[item.role]}` }}</small>
        </button>
      </li>
    </ul>
    <div v-if="doc" class="options">
      <MenuSelect v-model="role" :options="roleOptions" label="邀请的权限" />
      <label class="d-check"><input v-model="canShare" type="checkbox">允许对方再分享给其他人</label>
    </div>
    <div class="d-actions">
      <button class="d-btn" type="button" @click="emit('close')">取消</button>
      <button class="d-btn primary" type="button" :disabled="!doc" @click="emit('pick', { doc_id: selected, role, can_share: canShare })">发送邀请</button>
    </div>
  </DriveDialog>
</template>

<style scoped>
.intro { margin:6px 0 0; }
.empty { padding:28px 0; text-align:center; }
.docs { list-style:none; margin:14px 0 0; padding:0; max-height:42vh; overflow:auto; }
.docs li + li { margin-top:6px; }
.docs button { display:flex; align-items:center; gap:12px; width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--surface); color:var(--text); font:14px var(--font); text-align:left; cursor:pointer; transition:border-color .2s,background .2s; }
.docs button:hover { border-color:var(--line-strong); }
.docs button.on { border-color:var(--accent); background:var(--accent-soft); }
.docs svg { flex:none; width:20px; height:20px; fill:none; stroke:var(--accent); stroke-width:1.5; stroke-linecap:round; stroke-linejoin:round; }
.title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.docs small { flex:none; color:var(--faint); font-size:12px; }
.options { display:flex; flex-wrap:wrap; align-items:center; gap:14px; margin-top:16px; }
.options .d-check { margin:0; }
</style>
