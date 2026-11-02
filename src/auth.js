const root = () => document.getElementById('app');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const redirectTo = () => window.location.origin + window.location.pathname;

function heErr(e) {
  const m = String(e && e.message || '').toLowerCase();
  if (m.includes('invalid login')) return 'אימייל או סיסמה שגויים';
  if (m.includes('email not confirmed')) return 'האימייל טרם אומת. בדוק את תיבת הדואר שלך';
  if (m.includes('already registered') || m.includes('already been registered')) return 'כתובת האימייל כבר רשומה';
  if (m.includes('password should be') || m.includes('weak')) return 'הסיסמה חלשה מדי (לפחות 6 תווים)';
  if (m.includes('same password')) return 'הסיסמה החדשה זהה לקודמת';
  if (m.includes('rate limit') || (e && e.status === 429)) return 'יותר מדי ניסיונות, נסה שוב בעוד דקה';
  if (m.includes('network') || m.includes('fetch')) return 'בעיית רשת. בדוק את החיבור ונסה שוב';
  return 'אירעה שגיאה: ' + (e && e.message || '');
}

function layout(title, sub, body) {
  root().innerHTML = `<div class="authwrap"><div class="logo">💸</div><h1>${title}</h1><div class="sub">${sub}</div>${body}</div>`;
}

/** Login / signup / forgot-password screen. */
export function showAuth(supabase, mode = 'login', notice = null) {
  const isSignup = mode === 'signup', isForgot = mode === 'forgot';
  const title = isForgot ? 'איפוס סיסמה' : isSignup ? 'יצירת חשבון' : 'ברוכים הבאים';
  const sub = isForgot ? 'נשלח אליך קישור לאיפוס' : isSignup ? 'כמה שניות ואתה בפנים' : 'התחבר כדי לנהל הכנסות והוצאות';
  layout(title, sub, `
    ${notice ? `<div class="msg ${notice.type}" role="status" style="margin-bottom:12px">${esc(notice.text)}</div>` : ''}
    ${isForgot ? '' : `<div class="tabs"><button type="button" class="${!isSignup ? 'on' : ''}" data-m="login">התחברות</button><button type="button" class="${isSignup ? 'on' : ''}" data-m="signup">הרשמה</button></div>`}
    <form id="af" novalidate>
      <div><label class="fl" style="margin-top:0" for="em">אימייל</label><input id="em" type="email" autocomplete="username" inputmode="email" required></div>
      ${isForgot ? '' : `<div><label class="fl" style="margin-top:0" for="pw">סיסמה</label><input id="pw" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="6" required></div>`}
      ${isSignup ? `<div><label class="fl" style="margin-top:0" for="pw2">אימות סיסמה</label><input id="pw2" type="password" autocomplete="new-password" required></div>` : ''}
      <div id="am" class="msg err" role="alert" hidden></div>
      <button class="btn" id="sb" type="submit">${isForgot ? 'שלח קישור איפוס' : isSignup ? 'יצירת חשבון' : 'התחברות'}</button>
      ${isForgot ? '<button type="button" class="lnk" data-m="login">חזרה להתחברות</button>' : (!isSignup ? '<button type="button" class="lnk" data-m="forgot">שכחתי סיסמה</button>' : '')}
    </form>`);

  const $ = id => document.getElementById(id);
  root().querySelectorAll('[data-m]').forEach(b => b.addEventListener('click', () => showAuth(supabase, b.dataset.m)));
  const fail = t => { const a = $('am'); a.textContent = t; a.hidden = false; };
  $('af').addEventListener('submit', async ev => {
    ev.preventDefault();
    const email = $('em').value.trim(), pw = $('pw') ? $('pw').value : '';
    if (!/^\S+@\S+\.\S+$/.test(email)) return fail('הזן כתובת אימייל תקינה');
    if (!isForgot && pw.length < 6) return fail('הסיסמה חייבת להכיל לפחות 6 תווים');
    if (isSignup && pw !== $('pw2').value) return fail('הסיסמאות אינן תואמות');
    const btn = $('sb'); btn.disabled = true; $('am').hidden = true;
    try {
      if (isForgot) {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() });
        if (error) throw error;
        return showAuth(supabase, 'login', { type: 'ok', text: 'אם הכתובת רשומה, נשלח אליה קישור לאיפוס סיסמה.' });
      }
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({ email, password: pw, options: { emailRedirectTo: redirectTo() } });
        if (error) throw error;
        if (data.user && data.user.identities && data.user.identities.length === 0) throw new Error('already registered');
        if (!data.session) return showAuth(supabase, 'login', { type: 'ok', text: `שלחנו מייל אימות אל ${email}. לחץ על הקישור ואז התחבר.` });
        return; // email confirmation disabled: auth state change takes over
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
      if (error) throw error;
    } catch (e) {
      btn.disabled = false; fail(heErr(e));
    }
  });
  $('em').focus();
}

/** Shown after the user opens the password-recovery link from their email. */
export function showRecovery(supabase, onDone) {
  layout('סיסמה חדשה', 'בחר סיסמה חדשה לחשבון שלך', `
    <form id="rf" novalidate>
      <div><label class="fl" style="margin-top:0" for="np">סיסמה חדשה</label><input id="np" type="password" autocomplete="new-password" minlength="6" required></div>
      <div><label class="fl" style="margin-top:0" for="np2">אימות סיסמה</label><input id="np2" type="password" autocomplete="new-password" required></div>
      <div id="rm" class="msg err" role="alert" hidden></div>
      <button class="btn" id="rb" type="submit">עדכון סיסמה</button>
    </form>`);
  const fail = t => { const a = document.getElementById('rm'); a.textContent = t; a.hidden = false; };
  document.getElementById('rf').addEventListener('submit', async ev => {
    ev.preventDefault();
    const p = document.getElementById('np').value;
    if (p.length < 6) return fail('הסיסמה חייבת להכיל לפחות 6 תווים');
    if (p !== document.getElementById('np2').value) return fail('הסיסמאות אינן תואמות');
    const btn = document.getElementById('rb'); btn.disabled = true;
    const { error } = await supabase.auth.updateUser({ password: p });
    if (error) { btn.disabled = false; return fail(heErr(error)); }
    history.replaceState(null, '', window.location.pathname);
    onDone();
  });
}
