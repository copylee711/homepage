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
    const card = event.target.closest?.('.post-item,.note-card,.article-pager a,.not-found-links a');
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

  // 移动端导航可横向滚动：把当前栏目滚到可见位置。
  const navScroll = document.querySelector('.nav-scroll');
  const current = navScroll?.querySelector('.active');
  if (navScroll && current && navScroll.scrollWidth > navScroll.clientWidth) {
    navScroll.scrollLeft = current.offsetLeft - (navScroll.clientWidth - current.offsetWidth) / 2;
  }
  const edges = () => {
    if (!navScroll) return;
    navScroll.classList.toggle('fade-start', navScroll.scrollLeft > 4);
    navScroll.classList.toggle('fade-end', navScroll.scrollLeft + navScroll.clientWidth < navScroll.scrollWidth - 4);
  };
  navScroll?.addEventListener('scroll', edges, { passive: true });
  addEventListener('resize', edges, { passive: true });
  edges();

  // 笔记列表：本地搜索与分类筛选。
  const query = document.getElementById('notes-query');
  const chips = [...document.querySelectorAll('.notes-chips button')];
  if (query || chips.length) {
    let category = '';
    const filter = () => {
      const words = (query?.value ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const group of document.querySelectorAll('.note-group')) {
        let visible = 0;
        const groupMatch = !category || group.dataset.group === category;
        for (const card of group.querySelectorAll('[data-note]')) {
          const match = groupMatch && words.every(word => card.dataset.search.includes(word));
          card.hidden = !match;
          if (match) { visible++; card.classList.add('is-visible'); }
        }
        group.hidden = !visible;
        shown += visible;
      }
      document.querySelector('.notes-empty').hidden = shown > 0;
    };
    query?.addEventListener('input', filter);
    for (const chip of chips) chip.addEventListener('click', () => {
      category = chip.dataset.category;
      for (const other of chips) other.classList.toggle('active', other === chip);
      filter();
    });
  }

  // 访客账户：导航头像、收藏按钮与浏览记录。未登录时静默跳过。
  (async () => {
    let me;
    try {
      const response = await fetch('/api/account/me', { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) me = await response.json();
    } catch {}
    // 网盘与后台入口只对已开通的用户显示；新用户默认没有这些功能。
    document.querySelectorAll('[data-cloud]').forEach(el => { el.hidden = !me?.features?.drive; });
    document.querySelectorAll('.reading-admin').forEach(el => { el.hidden = !me?.features?.admin; });
    const link = document.getElementById('account-link');
    if (me && link) {
      link.title = me.user.name; link.setAttribute('aria-label', `账户：${me.user.name}`);
      const face = me.user.avatar ? Object.assign(document.createElement('img'), { src: me.user.avatar, alt: '' }) : Object.assign(document.createElement('span'), { className: 'initial', textContent: me.user.name.slice(0, 1).toUpperCase() });
      link.replaceChildren(face);
    }
    const button = document.querySelector('.fav-button');
    if (!button) return;
    const target = { kind: button.dataset.kind, slug: button.dataset.slug };
    const send = (path, body) => fetch(`/api/account${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf }, body: JSON.stringify(body) });
    const setState = on => { button.setAttribute('aria-pressed', String(on)); button.classList.toggle('on', on); button.querySelector('span').textContent = on ? '已收藏' : '收藏'; };
    if (me) {
      send('/history', target).catch(() => {});
      const state = await fetch(`/api/account/favorites/check?kind=${target.kind}&slug=${encodeURIComponent(target.slug)}`, { credentials: 'same-origin' }).then(r => r.json()).catch(() => ({}));
      setState(!!state.favorite);
    }
    button.addEventListener('click', async () => {
      if (!me) { location.href = `/account?next=${encodeURIComponent(location.pathname)}`; return; }
      const on = button.getAttribute('aria-pressed') !== 'true';
      button.disabled = true;
      const response = await send(on ? '/favorites' : '/favorites/remove', target).catch(() => null);
      button.disabled = false;
      if (response?.ok) { setState(on); if (on && !reduce) { button.classList.remove('pop'); void button.offsetWidth; button.classList.add('pop'); } }
    });
  })();

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
  // 笔记常用一级标题分节，目录按正文中实际出现的最高两级生成。
  const all = [...prose.querySelectorAll('h1,h2,h3')];
  const top = Math.min(...all.map(h => Number(h.tagName[1])));
  const headings = all.filter(h => Number(h.tagName[1]) <= top + 1);
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
      item.className = Number(heading.tagName[1]) > top ? 'sub' : '';
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
