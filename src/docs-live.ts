import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

// 实时连接单独成模块：文档列表页不需要加载 Yjs。
/** 打开一篇文档的实时连接；被服务器以权限原因关闭时停止自动重连，交给 onClose 处理。 */
export function connect(id: string, link: string, onClose: (code: number) => void) {
  const doc = new Y.Doc()
  const base = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/docs/ws`
  const provider = new WebsocketProvider(base, id, doc, { params: link ? { link } : {}, maxBackoffTime: 5000 })
  provider.on('connection-close', event => {
    const code = event?.code ?? 0
    if (code >= 4400 && code < 4500) {
      provider.shouldConnect = false
      onClose(code)
    }
  })
  return { doc, provider }
}
