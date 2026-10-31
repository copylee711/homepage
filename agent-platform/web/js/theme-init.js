/* Applied before the first paint to avoid a theme or layout flash. */
(function () {
  var root = document.documentElement;
  var theme = '';
  try { theme = localStorage.getItem('agent-theme') || ''; } catch (error) { theme = ''; }
  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.dataset.theme = theme;
  var sidebar = '';
  try { sidebar = localStorage.getItem('agent-sidebar') || ''; } catch (error) { sidebar = ''; }
  root.dataset.sidebar = sidebar === 'closed' ? 'closed' : 'open';
})();
