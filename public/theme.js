// Runs before the page paints, so a saved theme choice applies without a flash. No choice = follow the device.
try {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
