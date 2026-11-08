<script setup lang="ts">
// The Iris mark: a flame between two crescent leaves over a lotus lens and stem,
// traced as a single symmetric evenodd silhouette so it stays crisp from 16px to 1024px.
defineProps<{ size?: number }>();
</script>

<template>
  <svg
    class="brand-mark-svg"
    :width="size || 24"
    :height="size || 24"
    viewBox="192 177.5 640 640"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill-rule="evenodd"
      d="M512 187C559.8 233.7 585.8 301.4 586.1 368C588 418.2 561.8 462.5 539.5 504.8C568.1 486.6 601.7 469.3 613.6 435C624.3 411.1 621.5 383.6 616.5 359.5C673.7 375.9 678.2 458.3 634.5 493C681 502.6 731.9 529.4 754.5 572C713 650.6 619.5 691.7 533.5 694V786.5A21.5 21.5 0 0 1 490.5 786.5V694C404.5 691.7 311 650.6 269.5 572C292.1 529.4 343 502.6 389.5 493C345.8 458.3 350.3 375.9 407.5 359.5C402.5 383.6 399.7 411.1 410.4 435C422.3 469.3 455.9 486.6 484.5 504.8C462.2 462.5 436 418.2 437.9 368C438.2 301.4 464.2 233.7 512 187ZM512 280C548.3 343.3 546.6 423.4 512 487C477.4 423.4 475.7 343.3 512 280ZM533.1 567C535.4 540.6 563.3 525.1 588 526.7C628.3 528.1 667.4 545.9 696 574C658.7 623.9 594.3 649.5 533.1 649.5ZM490.9 567C488.6 540.6 460.7 525.1 436 526.7C395.7 528.1 356.6 545.9 328 574C365.3 623.9 429.7 649.5 490.9 649.5Z"
    />
  </svg>
</template>

<style scoped>
.brand-mark-svg { display: block; }
</style>
