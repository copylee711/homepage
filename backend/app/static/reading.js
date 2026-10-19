(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 滚动渐入：与主页 v-reveal 相同的阈值和节奏。
  const revealed = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-visible');
      revealed.unobserve(entry.target);
    }
  }, { threshold: .12, rootMargin: '0px 0px -6% 0px' });
  document.querySelectorAll('[data-reveal]').forEach(el => revealed.observe(el));

  // 列表与相邻文章卡片：网格高光跟随指针。
  document.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch') return;
    const card = event.target.closest?.('.post-item,.article-pager a,.not-found-links a');
    if (!card) return;
    const rect = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  }, { passive: true });

  const progress = document.querySelector('.reading-progress span');
  const floatTop = document.querySelector('.float-top');
  const article = document.querySelector('.article-body');
  let frame = 0;
  const onScroll = () => {
    frame = 0;
    floatTop?.classList.toggle('shown', scrollY > innerHeight * .8);
    if (!progress || !article) return;
    const rect = article.getBoundingClientRect();
    const total = rect.height - innerHeight * .6;
    const ratio = total > 0 ? Math.min(1, Math.max(0, -rect.top / total)) : 1;
    progress.style.transform = `scaleX(${ratio})`;
  };
  addEventListener('scroll', () => { frame ||= requestAnimationFrame(onScroll); }, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  onScroll();

  const prose = document.querySelector('.prose');
  if (!prose) return;

  // 标题锚点与目录。正文经服务器清洗不保留 id，这里按文字生成稳定 id。
  const used = new Set();
  const slug = text => {
    const base = text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
    let id = base, n = 2;
    while (used.has(id) || document.getElementById(id)) id = `${base}-${n++}`;
    used.add(id);
    return id;
  };
  const headings = [...prose.querySelectorAll('h2,h3')];
  for (const heading of headings) {
    heading.dataset.title = heading.textContent.trim();
    heading.id = slug(heading.dataset.title);
    const anchor = document.createElement('a');
    anchor.className = 'heading-anchor'; anchor.href = `#${heading.id}`; anchor.textContent = '#';
    anchor.setAttribute('aria-label', `链接到「${heading.dataset.title}」`);
    heading.append(anchor);
  }
  const toc = document.querySelector('.article-toc');
  if (toc && headings.length >= 2) {
    const list = toc.querySelector('ol');
    const links = new Map();
    for (const heading of headings) {
      const item = document.createElement('li'), link = document.createElement('a');
      item.className = heading.tagName === 'H3' ? 'sub' : '';
      link.href = `#${heading.id}`; link.textContent = heading.dataset.title;
      item.append(link); list.append(item); links.set(heading, link);
    }
    toc.hidden = false;
    // 目录高亮：视口上部 30% 内最后经过的标题。
    const spy = () => {
      let current = headings[0];
      for (const heading of headings) if (heading.getBoundingClientRect().top < innerHeight * .3) current = heading;
      for (const [heading, link] of links) link.classList.toggle('active', heading === current);
    };
    let spyFrame = 0;
    addEventListener('scroll', () => { spyFrame ||= requestAnimationFrame(() => { spyFrame = 0; spy(); }); }, { passive: true });
    spy();
  }
  if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();

  // 代码块：语言标签与复制按钮。
  for (const pre of prose.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const wrap = document.createElement('div'), bar = document.createElement('div');
    const lang = document.createElement('span'), copy = document.createElement('button');
    wrap.className = 'code-block'; bar.className = 'code-bar';
    lang.textContent = /language-([\w+#-]+)/.exec(code?.className ?? '')?.[1] ?? 'code';
    copy.type = 'button'; copy.textContent = '复制';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText((code ?? pre).innerText); copy.textContent = '已复制'; }
      catch { copy.textContent = '复制失败'; }
      setTimeout(() => { copy.textContent = '复制'; }, 1600);
    });
    bar.append(lang, copy);
    pre.replaceWith(wrap); wrap.append(bar, pre);
  }

  // 正文图片：懒加载并在加载完成后淡入。
  for (const img of prose.querySelectorAll('img')) {
    img.loading = 'lazy'; img.decoding = 'async';
    if (reduce || img.complete) continue;
    img.classList.add('img-pending');
    img.addEventListener('load', () => img.classList.remove('img-pending'), { once: true });
    img.addEventListener('error', () => img.classList.remove('img-pending'), { once: true });
  }
})();
