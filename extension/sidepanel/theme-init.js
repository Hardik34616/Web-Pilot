// Applies the saved theme before the first paint so the panel never flashes the wrong theme.
// (Classic, render-blocking script — extension pages don't allow inline scripts.)
(function () {
  var t = 'system';
  try { t = localStorage.getItem('wp-theme') || 'system'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', t === 'light' || t === 'dark' ? t : 'system');
})();
