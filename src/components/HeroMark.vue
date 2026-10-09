<template>
  <!-- 首屏用的字标：与 LogoMark 同形，入场时沿笔画方向"写"出来。
       遮罩里的粗描边顺着 C、L 的中线走，用 dashoffset 逐步露出下面的填充形状 -->
  <svg viewBox="0 0 340 280" fill="currentColor" aria-hidden="true">
    <defs>
      <mask id="hero-mark-c" maskUnits="userSpaceOnUse" x="0" y="0" width="340" height="280">
        <path class="draw draw-c" d="M262 25H140A112 112 0 0 0 140 249" pathLength="1" />
      </mask>
      <mask id="hero-mark-l" maskUnits="userSpaceOnUse" x="0" y="0" width="340" height="280">
        <path class="draw draw-l" d="M184 80V249H336" pathLength="1" />
      </mask>
    </defs>
    <path mask="url(#hero-mark-c)" d="M255 0H140A137 137 0 0 0 140 274V224A87 87 0 0 1 140 50H205Z" />
    <path mask="url(#hero-mark-l)" d="M160 80h48v144h122l-50 50H160Z" />
  </svg>
</template>

<style scoped>
.draw {
  fill: none;
  stroke: #fff;
  stroke-width: 56;
  stroke-dasharray: 1;
  stroke-dashoffset: 0;
  animation: draw 1.5s cubic-bezier(0.65, 0, 0.2, 1) 0.35s backwards;
}

.draw-l {
  animation-duration: 1.1s;
  animation-delay: 1.05s;
}

@keyframes draw {
  from {
    stroke-dashoffset: 1;
  }
}
</style>
