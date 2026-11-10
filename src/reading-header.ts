import { createApp } from 'vue'
import SiteHeader from './components/SiteHeader.vue'
import { account, accountApi, features, loadAccount } from './account'
import '@fontsource-variable/outfit'
import './styles/tokens.css'
import './styles/base.css'

const host = document.getElementById('reading-header')
if (host?.dataset.name) {
  createApp(SiteHeader, { readingSite: { name: host.dataset.name, cloud: host.dataset.cloud || '' } }).mount(host)
}

async function bindReadingAccount() {
  await loadAccount()
  document.querySelectorAll<HTMLElement>('[data-cloud]').forEach(el => { el.hidden = !features.value.drive })
  document.querySelectorAll<HTMLElement>('.reading-terms').forEach(el => { el.hidden = !(features.value.drive || features.value.images) })
  const button = document.querySelector<HTMLButtonElement>('.fav-button')
  const label = button?.querySelector('span')
  if (!button || !label) return
  const { kind, slug } = button.dataset
  const target = { kind, slug }
  const setState = (on: boolean) => {
    button.setAttribute('aria-pressed', String(on))
    button.classList.toggle('on', on)
    label.textContent = on ? '已收藏' : '收藏'
  }
  if (account.value) {
    void accountApi('/history', 'POST', target).catch(() => {})
    const state = await accountApi<{ favorite: boolean }>(
      `/favorites/check?${new URLSearchParams({ kind: kind || '', slug: slug || '' })}`,
    ).catch(() => null)
    setState(!!state?.favorite)
  }
  button.addEventListener('click', async () => {
    if (!account.value) { location.href = '/account?next=' + encodeURIComponent(location.pathname); return }
    const on = button.getAttribute('aria-pressed') !== 'true'
    button.disabled = true
    try {
      await accountApi(on ? '/favorites' : '/favorites/remove', 'POST', target)
      setState(on)
      if (on && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        button.classList.remove('pop')
        void button.offsetWidth
        button.classList.add('pop')
      }
    } catch {
      // Keep the prior state when saving fails.
    } finally {
      button.disabled = false
    }
  })
}

void bindReadingAccount()
