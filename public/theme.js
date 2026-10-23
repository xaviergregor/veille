/* Thème clair/sombre — à charger dans <head> (pas de defer) pour éviter le flash.
   Choix mémorisé dans localStorage ; sans choix, on suit la préférence système. */
(function () {
  var KEY = 'veille-theme';
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function systemDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function current() {
    return root.getAttribute('data-theme') || (systemDark() ? 'dark' : 'light');
  }
  function apply(theme, animate) {
    if (animate) {
      root.classList.add('theme-anim');
      setTimeout(function () { root.classList.remove('theme-anim'); }, 350);
    }
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#14151d' : '#f7f6f2');
    document.querySelectorAll('.theme-toggle').forEach(function (b) {
      b.setAttribute('aria-label', theme === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre');
      b.setAttribute('title', theme === 'dark' ? 'Thème clair' : 'Thème sombre');
    });
  }

  var s = stored();
  if (s === 'dark' || s === 'light') root.setAttribute('data-theme', s);

  window.toggleTheme = function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next, true);
  };

  // Suit les changements système tant que l'utilisateur n'a rien choisi
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (!stored()) apply(systemDark() ? 'dark' : 'light', true); };
    if (mq.addEventListener) mq.addEventListener('change', onChange); else if (mq.addListener) mq.addListener(onChange);
  }

  document.addEventListener('DOMContentLoaded', function () { apply(current(), false); });
})();
