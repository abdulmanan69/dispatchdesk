// Runs before the stylesheet and the app bundle: apply the saved theme so dark-mode users never see a light flash.
// Mirrors applyTheme() in src/context/theme.js (localStorage key "dd_theme": light | dark | system).
(function () {
  try {
    var theme = localStorage.getItem('dd_theme') || 'system';
    var dark = theme === 'dark' || (theme === 'system' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var root = document.documentElement;
    if (dark) root.classList.add('dark');
    root.setAttribute('data-theme', theme);
  } catch (e) {
    // Storage blocked: the app applies the theme once it loads.
  }
})();
