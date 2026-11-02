<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
const props=defineProps<{target:HTMLElement|null}>();
const visible=ref(false),active=ref(false),thumbHeight=ref(48),thumbTop=ref(0),max=ref(0),position=ref(0);
const targetId=ref('iris-chat-scroll-'+crypto.randomUUID());
let dispose=()=>{},timer:ReturnType<typeof setTimeout>|undefined;
function sync(){const el=props.target;if(!el)return;max.value=Math.max(0,el.scrollHeight-el.clientHeight);position.value=Math.round(el.scrollTop);visible.value=max.value>2;thumbHeight.value=Math.max(28,Math.min(68,el.clientHeight*el.clientHeight/el.scrollHeight));thumbTop.value=max.value?(el.clientHeight-thumbHeight.value)*el.scrollTop/max.value:0;}
function scroll(){sync();active.value=true;if(timer)clearTimeout(timer);timer=setTimeout(()=>{active.value=false;},700);}
watch(()=>props.target,(el)=>{dispose();if(!el)return;if(el.id)targetId.value=el.id;else el.id=targetId.value;const resize=new ResizeObserver(sync),mutation=new MutationObserver(sync);resize.observe(el);mutation.observe(el,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style']});el.addEventListener('scroll',scroll,{passive:true});dispose=()=>{resize.disconnect();mutation.disconnect();el.removeEventListener('scroll',scroll);};sync();},{immediate:true});
function drag(event:PointerEvent){const el=props.target;if(!el)return;event.preventDefault();const start=event.clientY,value=el.scrollTop,ratio=max.value/Math.max(1,el.clientHeight-thumbHeight.value);const target=event.currentTarget as HTMLElement;target.setPointerCapture(event.pointerId);active.value=true;const move=(e:PointerEvent)=>{el.scrollTop=value+(e.clientY-start)*ratio;};const end=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end);active.value=false;};target.addEventListener('pointermove',move);target.addEventListener('pointerup',end);target.addEventListener('pointercancel',end);}
function keyboard(event:KeyboardEvent){const el=props.target;if(!el)return;const actions:Record<string,number>={ArrowDown:el.scrollTop+40,ArrowUp:el.scrollTop-40,PageDown:el.scrollTop+el.clientHeight*.8,PageUp:el.scrollTop-el.clientHeight*.8,Home:0,End:max.value};if(event.key in actions){event.preventDefault();el.scrollTop=actions[event.key];}}
onBeforeUnmount(()=>{dispose();if(timer)clearTimeout(timer);});
</script>
<template><div v-if="visible" class="slim-scroll-rail" :class="{'is-active':active}"><div class="slim-scroll-thumb" role="scrollbar" tabindex="0" aria-label="滚动对话列表" aria-orientation="vertical" :aria-controls="targetId" :aria-valuenow="position" aria-valuemin="0" :aria-valuemax="max" :style="{height:thumbHeight+'px',transform:'translateY('+thumbTop+'px)'}" @pointerdown="drag" @keydown="keyboard"></div></div></template>
<style>
.slim-scroll-rail { position:absolute;top:0;right:-3px;bottom:0;width:12px;pointer-events:none; }
.slim-scroll-thumb { position:absolute;top:0;right:3px;width:3px;border-radius:8px;background:var(--sidebar-muted);opacity:.1;pointer-events:auto;touch-action:none;transition:opacity var(--fast);cursor:grab; }
.chat-list-shell:hover .slim-scroll-thumb,.slim-scroll-rail.is-active .slim-scroll-thumb,.slim-scroll-thumb:focus-visible { opacity:.28; }
.slim-scroll-thumb:active { cursor:grabbing;opacity:.42; }
@media(forced-colors:active){.slim-scroll-rail{display:none}.chat-list.slim-scroll-target{scrollbar-width:auto}.chat-list.slim-scroll-target::-webkit-scrollbar{display:block}}
</style>
