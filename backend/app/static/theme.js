(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const stored = () => { try { return localStorage.getItem('theme'); } catch { return null; } };
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = theme => {
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0c0d10' : '#fcfcfd');
    document.getElementById('theme-toggle')?.setAttribute('aria-label', theme === 'dark' ? '切换到浅色主题' : '切换到深色主题');
  };
  apply(['light','dark'].includes(stored()) ? stored() : system.matches ? 'dark' : 'light');
  system.addEventListener('change', event => { if (!stored()) apply(event.matches ? 'dark' : 'light'); });
  document.addEventListener('DOMContentLoaded', () => {
    apply(root.dataset.theme);
    const header = document.querySelector('.reading-header');
    const scroll = () => header?.classList.toggle('scrolled', window.scrollY > 8);
    scroll(); window.addEventListener('scroll', scroll, { passive:true });
    document.getElementById('theme-toggle')?.addEventListener('click', event => {
      const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('theme', next); } catch {}
      if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(next); return; }
      root.style.setProperty('--vt-x', `${event.clientX}px`);
      root.style.setProperty('--vt-y', `${event.clientY}px`);
      const transition = document.startViewTransition(() => apply(next));
      transition.ready.catch(() => {}); transition.finished.catch(() => {});
      setTimeout(() => { if (root.dataset.theme !== next) apply(next); }, 400);
    });
  });
})();
