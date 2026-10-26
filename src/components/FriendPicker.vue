<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ComboboxAnchor, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxPortal, ComboboxRoot, ComboboxViewport } from 'reka-ui'
import { loadFriends } from '../friends'
import type { Friend } from '../friends'

/**
 * 输入邮箱的同时从好友里挑人：聚焦时列出好友，输入时按昵称或邮箱筛选，选中后填入对方邮箱。
 * 不是好友的人仍可以直接输入完整邮箱。exclude 中的用户（如已是成员）不出现在候选里。
 */
const props = withDefaults(defineProps<{ modelValue: string; placeholder?: string; exclude?: string[] }>(), { placeholder: '对方的注册邮箱', exclude: () => [] })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const friends = ref<Friend[]>([])
const open = ref(false)

const term = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) })
const matches = computed(() => {
  const query = props.modelValue.trim().toLowerCase()
  return friends.value.filter(friend => !props.exclude.includes(friend.id) && (!query || friend.name.toLowerCase().includes(query) || friend.email.includes(query))).slice(0, 8)
})

function pick(value: unknown) {
  if (typeof value === 'string' && value) { emit('update:modelValue', value); open.value = false }
}

onMounted(async () => { friends.value = (await loadFriends().catch(() => null))?.friends ?? [] })
</script>

<template>
  <ComboboxRoot v-model:open="open" class="friend-picker" :model-value="''" ignore-filter open-on-focus open-on-click :reset-search-term-on-blur="false" :reset-search-term-on-select="false" @update:model-value="pick">
    <ComboboxAnchor class="friend-picker-anchor">
      <ComboboxInput v-model="term" class="d-input" type="email" :placeholder="friends.length ? `${placeholder}，或从好友中选择` : placeholder" autocomplete="off" required />
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent v-if="matches.length" class="menu-select-content friend-picker-content" position="popper" align="start" :side-offset="6" :collision-padding="16" :body-lock="false">
        <ComboboxViewport class="menu-select-viewport">
          <p class="friend-picker-label">好友</p>
          <ComboboxItem v-for="friend in matches" :key="friend.id" :value="friend.email" :text-value="friend.name" class="menu-select-option friend-picker-option">
            <span class="friend-picker-avatar"><img v-if="friend.avatar" :src="friend.avatar" alt=""><template v-else>{{ friend.name.slice(0, 1) }}</template></span>
            <span class="friend-picker-who"><strong>{{ friend.name }}</strong><small>{{ friend.email }}</small></span>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>

<style>
.friend-picker { flex:1; min-width:0; }
.friend-picker-anchor { display:flex; }
.friend-picker-anchor .d-input { flex:1; min-width:0; }
.menu-select-content.friend-picker-content { width:var(--reka-combobox-trigger-width); min-width:220px; max-height:min(320px,var(--reka-combobox-content-available-height)); overflow:auto; }
.friend-picker-label { margin:4px 10px 6px; color:var(--faint); font-size:11.5px; letter-spacing:.08em; }
.menu-select-option.friend-picker-option { justify-content:flex-start; gap:10px; }
.friend-picker-avatar { flex:none; display:grid; place-items:center; width:28px; height:28px; border-radius:50%; overflow:hidden; background:var(--accent-soft); color:var(--accent); font-size:13px; font-weight:600; }
.friend-picker-avatar img { width:100%; height:100%; object-fit:cover; }
.friend-picker-who { display:flex; flex-direction:column; min-width:0; }
.friend-picker-who strong { font-weight:500; color:var(--text); }
.friend-picker-who small { color:var(--faint); font-size:12px; overflow:hidden; text-overflow:ellipsis; }
</style>
