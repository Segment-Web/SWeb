const desktop = matchMedia('(min-width: 1024px) and (hover: hover) and (pointer: fine)').matches;
document.body.classList.toggle('desktop-required', !desktop);
if (desktop) {
  document.getElementById('desktopOnlyGate')?.remove();
  import('./app.js?rev=20260721');
} else {
  document.getElementById('gate')?.remove();
}
