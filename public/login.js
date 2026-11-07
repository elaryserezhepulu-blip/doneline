(async () => {
  const $ = (s) => document.querySelector(s);
  const err = (m) => { $('#err').textContent = m || ''; };
  const post = async (url, body) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Something went wrong');
    return d;
  };
  const st = await fetch('/api/auth/state').then((r) => r.json());
  if (st.authed) { location.href = '/app'; return; }
  const form = st.owner ? $('#login') : $('#setup');
  form.hidden = false;
  form.querySelector('input:not([hidden])').focus();

  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault(); err();
    try { await post('/api/auth/login', { password: $('#lPw').value }); location.href = '/app'; } catch (x) { err(x.message); $('#lPw').select(); }
  });
  $('#setup').addEventListener('submit', async (e) => {
    e.preventDefault(); err();
    if ($('#sPw').value !== $('#sPw2').value) return err('Passwords do not match');
    try {
      await post('/api/auth/setup', { code: $('#sCode').value, email: $('#sEmail').value, password: $('#sPw').value, tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
      location.href = '/app';
    } catch (x) { err(x.message); }
  });
})();
