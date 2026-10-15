// Applies the saved interface theme before first paint (no flash). Loaded as a plain blocking script in <head>.
(function () {
  var bg = { 'dark': '#0b1220', 'dark-red': '#150a0d', 'dark-green': '#07130b', 'dark-orange': '#150e07' };
  try {
    var t = localStorage.getItem('zn.uiTheme');
    if (!t || !bg[t]) return;
    document.documentElement.setAttribute('data-ui-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', bg[t]);
  } catch (e) { /* storage blocked: keep Dark */ }
})();
