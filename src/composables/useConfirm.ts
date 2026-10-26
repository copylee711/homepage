import { ref, shallowRef } from 'vue'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  /** 删除等不可恢复的操作，确认按钮显示为红色 */
  danger?: boolean
  /** 带输入框时由 promptDialog 使用 */
  input?: { placeholder?: string; multiline?: boolean }
}

export interface ConfirmRequest extends ConfirmOptions { resolve: (ok: boolean) => void }

/** 当前等待回答的确认请求，由 App 中挂载的 ConfirmDialog 渲染。 */
export const confirmRequest = shallowRef<ConfirmRequest>()
/** 输入框的当前内容 */
export const promptValue = ref('')

/** 替代 window.confirm：弹出站内样式的确认框，确认时得到 true，取消、Esc 或点遮罩得到 false。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // 同一时间只显示一个确认框，新的请求视为取消旧的。
  confirmRequest.value?.resolve(false)
  return new Promise(resolve => { confirmRequest.value = { ...options, resolve } })
}

/** 替代 window.prompt：确认时得到输入内容（已去掉首尾空白），取消得到 null。 */
export async function promptDialog(options: ConfirmOptions & { value?: string }): Promise<string | null> {
  promptValue.value = options.value ?? ''
  const ok = await confirmDialog({ ...options, input: options.input ?? {} })
  return ok ? promptValue.value.trim() : null
}
