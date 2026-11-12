<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { irisQuotaFields, type IrisQuota, type IrisQuotaDefaults } from '../irisQuota'

type StorageQuota = { quota_mb: number; max_image_mb: number }
const props = defineProps<{ api: <T>(path: string, method?: string, data?: unknown) => Promise<T> }>()
const emit = defineEmits<{ storageSaved: [quota: StorageQuota] }>()
const path = '/api/admin/permissions'
const storage = ref<StorageQuota>()
const iris = ref<IrisQuotaDefaults>()
const irisDraft = ref<IrisQuota>()
const sections = [
  { id: 'storage', title: '云盘与图床', note: '尚未建立存储方案的账户使用这些值。开通云盘或图床后，保存到该账户的配额可单独调整。' },
  { id: 'iris', title: 'Iris 沙箱', note: '尚未分配配额、也未创建工作区的账户使用这些值。已有工作区和单独分配的配额继续沿用原设置。' },
] as const
type Section = typeof sections[number]['id']
const status = ref<Record<Section, { busy: boolean; error: string; saved: boolean }>>({
  storage: { busy: false, error: '', saved: false },
  iris: { busy: false, error: '', saved: false },
})

async function update(section: Section, save = false) {
  const state = status.value[section]
  if (state.busy) return
  Object.assign(state, { busy: true, error: '', saved: false })
  const method = save ? 'PUT' : 'GET'
  try {
    if (section === 'storage') {
      storage.value = await props.api<StorageQuota>(path + '/storage/defaults', method, save ? storage.value : undefined)
      if (save) emit('storageSaved', storage.value)
    } else {
      iris.value = await props.api<IrisQuotaDefaults>(path + '/iris/defaults', method, save ? { quota: irisDraft.value } : undefined)
      irisDraft.value = { ...iris.value.quota }
    }
    state.saved = save
  } catch (err) {
    state.error = err instanceof Error ? err.message : '暂时无法读取或保存初始配额'
  } finally { state.busy = false }
}
onMounted(() => { void update('storage'); void update('iris') })
</script>

<template>
  <section class="admin-panel">
    <div class="section-head"><div class="head-copy"><h2>初始配额</h2><p class="field-hint">分别保存两个服务的默认值。各功能仍按账户授权。</p></div></div>
    <div class="cards">
    <section v-for="item in sections" :key="item.id" class="edit-card">
      <h3>{{ item.title }}</h3>
      <p class="field-hint note">{{ item.note }}</p>
      <form v-if="item.id === 'storage' ? storage : irisDraft" @submit.prevent="update(item.id, true)">
        <fieldset class="default-fields" :disabled="status[item.id].busy">
          <template v-if="item.id === 'storage' && storage">
            <label>共享总配额（MiB）<input v-model.number="storage.quota_mb" type="number" required min="1" max="10000000"></label>
            <label>单张图片上限（MiB）<input v-model.number="storage.max_image_mb" type="number" required min="1" max="20"></label>
          </template>
          <template v-if="item.id === 'iris' && iris && irisDraft">
            <label v-for="field in irisQuotaFields" :key="field.key">{{ field.label }}
              <input v-model.number="irisDraft[field.key]" type="number" required :step="field.step"
                :min="iris.ranges[field.key][0]"
                :max="field.key === 'disk_mib' ? Math.min(iris.ranges.disk_mib[1], iris.total_disk_budget_mib) : iris.ranges[field.key][1]">
            </label>
          </template>
        </fieldset>
        <button type="submit" class="primary" :disabled="status[item.id].busy">{{ status[item.id].busy ? '正在保存…' : '保存初始配额' }}</button>
      </form>
      <p v-else-if="status[item.id].busy" class="subtle" role="status">正在读取初始配额…</p>
      <button v-else type="button" @click="update(item.id)">重试</button>
      <p v-if="status[item.id].error" class="subtle" role="alert">{{ status[item.id].error }}</p>
      <p v-if="status[item.id].saved" class="subtle" role="status">初始配额已保存。</p>
    </section>
    </div>
  </section>
</template>

<style scoped>
h3 { margin:0; font-size:15px; }
.head-copy { display:grid; gap:4px; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr)); gap:16px; align-items:start; }
.admin-panel .cards .edit-card { margin:0; padding:18px 20px; }
.note { display:block; margin:4px 0 14px; }
.default-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr)); gap:10px; border:0; padding:0; margin:0 0 14px; min-width:0; }
.admin-panel .default-fields label { font-size:12px; gap:4px; }
.admin-panel .default-fields input { padding:7px 10px; font-size:13px; }
.admin-panel .subtle { margin:10px 0 0; font-size:13px; }
</style>
