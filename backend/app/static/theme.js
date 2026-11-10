(() => {
  const root = document.documentElement;
  root.classList.add('js');
  const stored = () => { try { return localStorage.getItem('theme'); } catch { return null; } };
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = theme => {
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0c0d10' : '#fcfcfd');
  };
  apply(['light','dark'].includes(stored()) ? stored() : system.matches ? 'dark' : 'light');
  system.addEventListener('change', event => { if (!stored()) apply(event.matches ? 'dark' : 'light'); });
})();
