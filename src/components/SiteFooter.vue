<script setup lang="ts">
import { site } from '../site.config'

const year = new Date().getFullYear()
</script>

<template>
  <footer class="footer">
    <div class="container inner">
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
  </footer>
</template>

<style scoped>
.footer {
  border-top: 1px solid var(--line);
  color: var(--faint);
  font-size: 13px;
}

.inner {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 24px;
  padding-block: 28px;
}

.beian {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
}

.beian a:hover {
  color: var(--text);
}
</style>
