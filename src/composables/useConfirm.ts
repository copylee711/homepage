import { shallowRef } from 'vue'

export interface ConfirmOptions {
  title: string
  message?: string
  confirmText?: string
  cancelText?: string
  /** 删除等不可恢复的操作，确认按钮显示为红色 */
  danger?: boolean
}

export interface ConfirmRequest extends ConfirmOptions { resolve: (ok: boolean) => void }

/** 当前等待回答的确认请求，由 App 中挂载的 ConfirmDialog 渲染。 */
export const confirmRequest = shallowRef<ConfirmRequest>()

/** 替代 window.confirm：弹出站内样式的确认框，确认时得到 true，取消、Esc 或点遮罩得到 false。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // 同一时间只显示一个确认框，新的请求视为取消旧的。
  confirmRequest.value?.resolve(false)
  return new Promise(resolve => { confirmRequest.value = { ...options, resolve } })
}
