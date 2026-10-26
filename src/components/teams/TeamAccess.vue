<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { confirmDialog } from '../../composables/useConfirm'
import { formatTime } from '../../drive'
import { teamsApi } from '../../teams'
import type { AppPassword, Team, TeamAccess } from '../../teams'
import DriveDialog from '../drive/DriveDialog.vue'

/** 映射到本地：团队专属的 WebDAV 地址、登录名与应用密码，以及 Windows 上的映射步骤。 */
const props = defineProps<{ team: Team }>()
const emit = defineEmits<{ close: [] }>()

const access = ref<TeamAccess>()
const created = ref(''), name = ref('')
const busy = ref(false), error = ref(''), copied = ref('')

// 应用密码接口在 /api/teams-access 下，与具体团队无关。
const apiAccess = <T>(path: string, method = 'GET', data?: unknown) => teamsApi<T>(`-access${path}`, method, data)

async function load() {
  try { access.value = await apiAccess<TeamAccess>('') }
  catch (err) { error.value = err instanceof Error ? err.message : '读取失败' }
}

async function create() {
  busy.value = true; error.value = ''
  try {
    const result = await apiAccess<AppPassword & { password: string }>('/app-passwords', 'POST', { name: name.value || `团队 ${props.team.name}` })
    created.value = result.password; name.value = ''
    await load()
  } catch (err) { error.value = err instanceof Error ? err.message : '创建失败' }
  finally { busy.value = false }
}

async function remove(item: AppPassword) {
  if (!await confirmDialog({ title: `删除「${item.name}」？`, message: '用这个密码映射的磁盘会立即断开。', confirmText: '删除', danger: true })) return
  try { access.value!.passwords = (await apiAccess<{ passwords: AppPassword[] }>(`/app-passwords/${item.id}/remove`, 'POST')).passwords }
  catch (err) { error.value = err instanceof Error ? err.message : '删除失败' }
}

async function copy(text: string, key: string) {
  try { await navigator.clipboard.writeText(text); copied.value = key; setTimeout(() => { copied.value = '' }, 1500) }
  catch { error.value = '无法访问剪贴板，请手动复制' }
}

onMounted(load)
</script>

<template>
  <DriveDialog title="映射到本地" :eyebrow="team.name" wide @close="emit('close')">
    <p class="d-muted lead">把这个团队映射成电脑上的一个盘，像本地文件夹一样直接打开、保存。{{ team.role === 'view' ? '你是只读成员，映射出来也是只读的。' : '' }}</p>
    <p v-if="error" class="d-note error" role="alert">{{ error }}</p>
    <dl v-if="access" class="info">
      <dt>地址</dt><dd><span class="d-code">{{ team.dav_url }}</span><button class="d-btn quiet" type="button" @click="copy(team.dav_url, 'url')">{{ copied === 'url' ? '已复制' : '复制' }}</button></dd>
      <dt>用户名</dt><dd><span class="d-code">{{ access.login }}</span><span v-if="access.login !== access.email" class="d-muted">（也可以用邮箱 {{ access.email }}）</span></dd>
      <dt>密码</dt><dd>应用密码（不是网站密码），在下面生成</dd>
    </dl>

    <h3>Windows</h3>
    <ol class="steps">
      <li>打开“此电脑”，点上方的“⋯”→“映射网络驱动器”。</li>
      <li>选一个盘符，文件夹填上面的地址，勾选“使用其他凭据连接”。</li>
      <li>输入用户名和应用密码，勾选“记住我的凭据”。</li>
    </ol>
    <p class="d-muted small">也可以在命令行里运行 <span class="d-code">net use T: {{ team.dav_url }} /user:{{ access?.login }} /persistent:yes</span>。macOS 在访达里“连接服务器”填同一个地址。团队文档会以只读的 .md 文件出现，修改请到网页上进行。</p>

    <h3>应用密码</h3>
    <p v-if="created" class="d-note ok created">新密码：<span class="d-code">{{ created }}</span><button class="d-btn quiet" type="button" @click="copy(created, 'password')">{{ copied === 'password' ? '已复制' : '复制' }}</button><br>只显示这一次，请现在保存到映射设置里。</p>
    <form class="inline" @submit.prevent="create">
      <input v-model="name" class="d-input" maxlength="80" placeholder="用途，例如“宿舍电脑”" aria-label="应用密码用途">
      <button class="d-btn primary" type="submit" :disabled="busy">生成应用密码</button>
    </form>
    <ul v-if="access?.passwords.length" class="passwords">
      <li v-for="item in access.passwords" :key="item.id">
        <span><strong>{{ item.name }}</strong><small>创建于 {{ formatTime(item.created_at) }}<template v-if="item.last_used"> · 最近使用 {{ formatTime(item.last_used) }}</template></small></span>
        <button class="d-btn quiet danger" type="button" @click="remove(item)">删除</button>
      </li>
    </ul>
    <p class="d-muted small">应用密码与云盘设置里的是同一套，可以访问你所在的全部团队；开通了云盘的话也能访问个人云盘。</p>
  </DriveDialog>
</template>

<style scoped>
.lead { margin-top:10px; }
.info { display:grid; grid-template-columns:auto 1fr; gap:10px 16px; margin:18px 0 6px; font-size:14px; }
.info dt { color:var(--muted); }
.info dd { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:0; min-width:0; overflow-wrap:anywhere; }
h3 { margin:22px 0 8px; font-size:15px; }
.steps { margin:0; padding-left:20px; display:grid; gap:4px; font-size:14px; color:var(--text-2); }
.small { margin-top:8px; font-size:12.5px; line-height:1.8; }
.inline { display:flex; gap:8px; }
.inline .d-input { flex:1; min-width:0; }
.created { line-height:1.9; }
.passwords { list-style:none; margin:12px 0 0; padding:0; }
.passwords li { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 0; border-top:1px solid var(--line); }
.passwords span { display:grid; min-width:0; }
.passwords strong { font-weight:500; font-size:14px; }
.passwords small { color:var(--faint); font-size:12px; }
</style>
