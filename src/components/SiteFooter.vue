<script setup lang="ts">
import { site } from '../site.config'
import LogoMark from './LogoMark.vue'

const year = new Date().getFullYear()
</script>

<template>
  <footer class="footer">
    <div class="container">
      <div class="main">
        <a class="brand" href="#top" aria-label="回到顶部">
          <LogoMark class="logo" />
        </a>
        <nav class="links" aria-label="页脚导航">
          <a :href="`https://github.com/${site.github}`" target="_blank" rel="noopener">GitHub</a>
          <a :href="site.notes" target="_blank" rel="noopener">Notes</a>
          <a :href="site.cloud" target="_blank" rel="noopener">Cloud</a>
          <a class="top" href="#top">Back to top <span aria-hidden="true">↑</span></a>
        </nav>
      </div>

      <div class="legal">
        <span>© {{ year }} {{ site.name }}</span>
        <span v-if="site.icp || site.police.text" class="beian">
          <a v-if="site.icp" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">
            {{ site.icp }}
          </a>
          <a
            v-if="site.police.text"
            :href="`https://beian.mps.gov.cn/#/query/webSearch?code=${site.police.code}`"
            target="_blank"
            rel="noopener"
          >
            {{ site.police.text }}
          </a>
        </span>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.footer {
  margin-top: clamp(24px, 4vw, 48px);
  border-top: 1px solid var(--line);
  color: var(--faint);
  font-size: 13px;
}

.main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 20px 32px;
  padding-block: 36px 28px;
}

.brand {
  display: inline-flex;
  color: var(--text);
  transition: transform 0.5s var(--ease);
}

.brand:hover {
  transform: translateY(-3px);
}

.logo {
  width: 34px;
  height: auto;
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
  color: var(--muted);
  font-size: 14px;
}

.links a,
.beian a {
  transition: color 0.2s ease;
}

.links a:hover,
.beian a:hover {
  color: var(--text);
}

.top span {
  display: inline-block;
  transition: transform 0.4s var(--ease);
}

.top:hover span {
  transform: translateY(-3px);
}

.legal {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 24px;
  padding-block: 0 28px;
}

.beian {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
}
</style>
