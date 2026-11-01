/* Apply the stored theme before first paint to avoid a flash. Loaded as an external
   script so a strict CSP (script-src 'self', no unsafe-inline) allows it. */
(function () {
  try {
    var t = localStorage.getItem('iris-theme');
    if (t !== 'light' && t !== 'dark') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = t;
  } catch (e) { document.documentElement.dataset.theme = 'light'; }
})();
