<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
const props=defineProps<{items:Array<{index:number;label:string}>;active:number}>();
const emit=defineEmits<{(event:'jump',index:number):void}>();
const list=ref<HTMLElement|null>(null);
watch(()=>props.active,async()=>{await nextTick();const root=list.value,item=root?.querySelector<HTMLElement>('[aria-current="location"]');if(root&&item){if(item.offsetTop<root.scrollTop)root.scrollTop=item.offsetTop;else if(item.offsetTop+item.offsetHeight>root.scrollTop+root.clientHeight)root.scrollTop=item.offsetTop+item.offsetHeight-root.clientHeight;}});
function keyboard(event:KeyboardEvent){const buttons=Array.from(list.value?.querySelectorAll<HTMLButtonElement>('button')||[]),index=buttons.indexOf(document.activeElement as HTMLButtonElement);let next=-1;if(event.key==='ArrowDown')next=Math.min(buttons.length-1,index+1);if(event.key==='ArrowUp')next=Math.max(0,index-1);if(event.key==='Home')next=0;if(event.key==='End')next=buttons.length-1;if(event.key==='Escape'){(document.activeElement as HTMLElement|null)?.blur();event.stopPropagation();}if(next>=0){event.preventDefault();buttons[next]?.focus();}}
function choose(index:number){(document.activeElement as HTMLElement|null)?.blur();emit('jump',index);}
</script>
<template><nav v-if="items.length>1" class="turn-navigator" aria-label="本会话消息导航" @keydown="keyboard"><div ref="list" class="turn-nav-list"><button v-for="(item,n) in items" :key="item.index" type="button" class="turn-nav-item" :title="item.label" :aria-label="'跳转到第 '+(n+1)+' 条用户消息：'+item.label" :aria-current="active===item.index?'location':undefined" @click="choose(item.index)"><span class="turn-nav-label">{{item.label}}</span><span class="turn-nav-mark" aria-hidden="true"></span></button></div></nav></template>
<style>
.turn-navigator { position:absolute;z-index:4;right:5px;top:50%;transform:translateY(-50%);width:28px;max-height:min(72%,440px);display:flex;flex-direction:column;border:1px solid transparent;border-radius:var(--radius-md);padding:5px 0;transition:width var(--fast),background-color var(--fast),box-shadow var(--fast); }
.turn-navigator:hover,.turn-navigator:focus-within { width:min(280px,calc(100% - 32px));background:var(--surface);border-color:var(--line-2);box-shadow:var(--shadow-lg); }
.turn-nav-list { position:relative;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none; }
.turn-nav-list::-webkit-scrollbar { display:none; }
.turn-nav-item { display:flex;align-items:center;justify-content:flex-end;gap:10px;width:100%;height:24px;padding:0 9px;border-radius:var(--radius-xs);font-size:12px;color:var(--muted); }
.turn-nav-item:hover { background:var(--bg-tint);color:var(--text); }
.turn-nav-label { display:none;min-width:0;text-overflow:ellipsis;overflow:hidden;white-space:nowrap; }
.turn-navigator:hover .turn-nav-label,.turn-navigator:focus-within .turn-nav-label { display:block; }
.turn-nav-mark { flex:none;width:10px;height:2px;border-radius:2px;background:var(--line-strong); }
.turn-nav-item[aria-current='location'] { color:var(--text);font-weight:600; }
.turn-nav-item[aria-current='location'] .turn-nav-mark { width:18px;background:var(--accent); }
@media(max-width:640px){.turn-navigator{right:1px;}.turn-nav-item{height:28px;}}
</style>
