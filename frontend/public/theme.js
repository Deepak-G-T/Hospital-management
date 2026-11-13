// Apply the saved (or system) theme before the first paint to avoid a flash.
// A separate file (not an inline <script>) so the Content-Security-Policy can forbid inline scripts.
try {
  var t = localStorage.getItem('theme');
  document.documentElement.dataset.theme = t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch (e) { document.documentElement.dataset.theme = 'light'; }
