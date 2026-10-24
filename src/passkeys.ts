function decode(value: string): ArrayBuffer {
  const text = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(text, char => char.charCodeAt(0)).buffer
}
function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function passkeyAvailable() { return window.isSecureContext && !!window.PublicKeyCredential && !!navigator.credentials }
export async function usePasskey(options: Record<string, any>, register = false) {
  if (!passkeyAvailable()) throw new Error('此浏览器或地址暂不支持 Passkey，请使用 HTTPS 或 localhost。')
  const publicKey: Record<string, any> = {...options, challenge: decode(options.challenge)}
  if (register) {
    publicKey.user = {...options.user, id: decode(options.user.id)}
    publicKey.excludeCredentials = (options.excludeCredentials ?? []).map((value: any) => ({...value, id:decode(value.id)}))
  } else publicKey.allowCredentials = (options.allowCredentials ?? []).map((value: any) => ({...value, id:decode(value.id)}))
  let credential: PublicKeyCredential | null
  try {
    credential = await (register ? navigator.credentials.create({publicKey: publicKey as PublicKeyCredentialCreationOptions}) : navigator.credentials.get({publicKey: publicKey as PublicKeyCredentialRequestOptions})) as PublicKeyCredential | null
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') throw new Error('Passkey 操作已取消或超时，可重试或使用密码登录。')
    if (error instanceof DOMException && error.name === 'InvalidStateError') throw new Error('此设备的 Passkey 已绑定，请换一个设备。')
    throw error
  }
  if (!credential) throw new Error('未取得 Passkey')
  const response = credential.response
  const data: Record<string, unknown> = {clientDataJSON:encode(response.clientDataJSON)}
  if (register) {
    const registration = response as AuthenticatorAttestationResponse
    data.attestationObject = encode(registration.attestationObject)
    data.transports = registration.getTransports?.() ?? []
  } else {
    const authentication = response as AuthenticatorAssertionResponse
    data.authenticatorData = encode(authentication.authenticatorData)
    data.signature = encode(authentication.signature)
    data.userHandle = authentication.userHandle ? encode(authentication.userHandle) : null
  }
  return {id:credential.id, rawId:encode(credential.rawId), type:credential.type, response:data,
    clientExtensionResults:credential.getClientExtensionResults(), authenticatorAttachment:credential.authenticatorAttachment}
}

/** 服务器已不认识的 Passkey：通知浏览器从密码管理器中移除（Chrome 132+ 支持，其他浏览器忽略）。 */
export const UNKNOWN_PASSKEY = '这个 Passkey 已不在本站，请改用密码或其他 Passkey 登录'
export async function forgetPasskey(rpId: string | undefined, credentialId: string) {
  const api = window.PublicKeyCredential as unknown as { signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void> }
  if (!rpId || !api?.signalUnknownCredential) return
  await api.signalUnknownCredential({ rpId, credentialId }).catch(() => {})
}
