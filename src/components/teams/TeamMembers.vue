<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { account } from '../../account'
import { confirmDialog } from '../../composables/useConfirm'
import { roleLabel, teamsApi } from '../../teams'
import type { Team, TeamMember } from '../../teams'
import DriveDialog from '../drive/DriveDialog.vue'
import FriendPicker from '../FriendPicker.vue'
import MenuSelect from '../MenuSelect.vue'

const props = defineProps<{ team: Team }>()
const emit = defineEmits<{ close: []; changed: []; left: [] }>()

const members = ref<TeamMember[]>([])
const email = ref(''), role = ref<'edit' | 'view'>('edit')
const busy = ref(false), error = ref('')
const isOwner = props.team.role === 'owner'
const roleOptions = [{ value: 'edit', label: '可编辑' }, { value: 'view', label: '只读' }]

async function run(work: () => Promise<{ members: TeamMember[] }>) {
  busy.value = true; error.value = ''
  try { members.value = (await work()).members; emit('changed') }
  catch (err) { error.value = err instanceof Error ? err.message : '操作失败' }
  finally { busy.value = false }
}

const invite = () => run(async () => {
  const result = await teamsApi<{ members: TeamMember[] }>(`/${props.team.id}/members`, 'POST', { email: email.value.trim(), role: role.value })
  email.value = ''
  return result
})
const setRole = (member: TeamMember, value: 'edit' | 'view') => run(() => teamsApi(`/${props.team.id}/members`, 'POST', { user_id: member.id, role: value }))

async function remove(member: TeamMember) {
  const self = member.id === account.value?.id
  const ok = await confirmDialog(self
    ? { title: '退出团队？', message: '退出后无法再访问团队的文件与文档；你在团队里建的文档会转给团队所有者。', confirmText: '退出', danger: true }
    : { title: `移除 ${member.name}？`, message: '对方建的团队文档会转给你。', confirmText: '移除', danger: true })
  if (!ok) return
  await run(() => teamsApi(`/${props.team.id}/members/${member.id}/remove`, 'POST'))
  if (self) emit('left')
}

onMounted(() => run(() => teamsApi(`/${props.team.id}/members`)))
</script>

<template>
  <DriveDialog title="成员" :eyebrow="team.name" @close="emit('close')">
    <form v-if="isOwner" class="invite" @submit.prevent="invite">
      <FriendPicker v-model="email" :exclude="members.map(member => member.id)" />
      <MenuSelect v-model="role" :options="roleOptions" label="邀请的权限" />
      <button class="d-btn primary" type="submit" :disabled="busy || !email.trim()">邀请</button>
    </form>
    <p v-if="isOwner" class="d-muted hint">可编辑成员能上传、修改和删除文件，编辑全部团队文档；只读成员只能浏览和下载。</p>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <ul>
      <li v-for="member in members" :key="member.id">
        <span class="avatar"><img v-if="member.avatar" :src="member.avatar" alt=""><template v-else>{{ member.name.slice(0, 1) }}</template></span>
        <span class="who"><strong>{{ member.name }}<template v-if="member.id === account?.id">（你）</template></strong><small>{{ member.email }}</small></span>
        <MenuSelect v-if="isOwner && member.role !== 'owner'" :model-value="member.role" :options="roleOptions" :label="`${member.name} 的权限`" :disabled="busy" @update:model-value="value => setRole(member, value as 'edit' | 'view')" />
        <span v-else class="d-muted">{{ roleLabel[member.role] }}</span>
        <button v-if="member.role !== 'owner' && (isOwner || member.id === account?.id)" class="d-btn quiet danger" type="button" :disabled="busy" @click="remove(member)">{{ member.id === account?.id ? '退出' : '移除' }}</button>
      </li>
    </ul>
  </DriveDialog>
</template>

<style scoped>
.invite { display:flex; gap:8px; margin-top:14px; }
.invite :deep(.friend-picker) { flex:1; min-width:0; }
.hint { margin-top:8px; font-size:12.5px; }
ul { list-style:none; margin:14px 0 0; padding:0; }
li { display:flex; align-items:center; gap:10px; padding:10px 0; border-top:1px solid var(--line); }
.avatar { flex:none; display:grid; place-items:center; width:32px; height:32px; border-radius:50%; overflow:hidden; background:var(--accent-soft); color:var(--accent); font-weight:600; font-size:14px; }
.avatar img { width:100%; height:100%; object-fit:cover; }
.who { flex:1; display:grid; min-width:0; }
.who strong { font-weight:500; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.who small { color:var(--faint); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (max-width:760px) { .invite { flex-wrap:wrap; } .invite :deep(.friend-picker) { flex-basis:100%; } }
</style>
