// Applies a stored light/dark override before first paint to avoid a flash of the
// wrong theme. With nothing stored, CSS follows the OS (prefers-color-scheme).
// Classic script, loaded from <head>. Key must match THEME_KEY in js/api.js.
(function () {
  try {
    var t = localStorage.getItem("vg_theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) { /* storage unavailable: just follow the OS */ }
})();
