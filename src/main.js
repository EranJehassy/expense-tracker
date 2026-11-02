import { supabase, configured } from './supabase.js';
import { showAuth, showRecovery } from './auth.js';
import { loadAll, createSync } from './data.js';

/* ============ storage (Supabase-backed, see data.js) ============ */
let sync = null, currentUser = null;
function emptyState() { return { v: 1, txs: [], cats: DEFAULT_CATS.map(c => ({ ...c })), rules: [], budgets: {} }; }
function save() { if (sync) sync.schedule(); }
const DEFAULT_CATS = [
  { id: 'housing', name: 'דיור', icon: '🏠', color: '#3987e5' },
  { id: 'car', name: 'רכב', icon: '🚗', color: '#9085e9' },
  { id: 'food', name: 'מזון וסופר', icon: '🛒', color: '#199e70' },
  { id: 'bills', name: 'חשבונות', icon: '💡', color: '#c98500' },
  { id: 'insurance', name: 'ביטוחים', icon: '🛡️', color: '#d95926' },
  { id: 'fun', name: 'בילוי ומסעדות', icon: '🍽️', color: '#d55181' },
  { id: 'invest', name: 'השקעות', icon: '📈', color: '#3aa655' },
  { id: 'other', name: 'אחר', icon: '📦', color: '#8e97a6' }
];
let S = emptyState();
const INCOME_KINDS = {
  salary: { name: 'משכורת', icon: '💼' },
  reserve: { name: 'מילואים', icon: '🪖' },
  other: { name: 'אחר', icon: '➕' }
};
const CAT_COLORS = ['#3987e5', '#9085e9', '#199e70', '#c98500', '#d95926', '#d55181', '#3aa655', '#e66767', '#2db7c9', '#8e97a6'];
const EMOJIS = ['🏠', '🚗', '🛒', '💡', '🛡️', '🍽️', '📈', '📦', '👶', '🎓', '🏥', '✈️', '🎁', '👕', '📱', '🐶', '🏋️', '☕', '🎬', '🔧', '💳', '🏦', '🚌', '🧾'];

/* ============ helpers ============ */
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fromDate = d => iso(d.getFullYear(), d.getMonth(), d.getDate());
const fmtD = s => { const [y, m, d] = s.split('-'); return `${d}.${m}.${y}`; };
const todayStr = () => fromDate(new Date());
const lastDay = (y, m) => new Date(y, m + 1, 0).getDate();
const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const MSHORT = ["ינו׳", "פבר׳", "מרץ", "אפר׳", "מאי", "יוני", "יולי", "אוג׳", "ספט׳", "אוק׳", "נוב׳", "דצמ׳"];
const nf = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });
const money = n => `<span class="num">₪${nf.format(n)}</span>`;
const moneyT = n => `₪${nf.format(n)}`;
function monthRange(y, m) { const d = new Date(y, m, 1); y = d.getFullYear(); m = d.getMonth(); return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) }; }
function isFullMonth(r) {
  const a = toDate(r.from), b = toDate(r.to);
  return a.getDate() === 1 && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && b.getDate() === lastDay(b.getFullYear(), b.getMonth());
}
function isFullMonths(r) {
  const a = toDate(r.from), b = toDate(r.to);
  return a.getDate() === 1 && b.getDate() === lastDay(b.getFullYear(), b.getMonth());
}
function rangeLabel(r) {
  if (isFullMonth(r)) { const d = toDate(r.from); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
  return `<span class="num">${fmtD(r.from)} – ${fmtD(r.to)}</span>`;
}
function monthsInRange(r) {
  const a = toDate(r.from), b = toDate(r.to);
  if (isFullMonths(r)) return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth() + 1;
  return Math.max(1 / 30, (Math.round((b - a) / 864e5) + 1) / 30.4375);
}

/* ============ ui state ============ */
const U = { page: 'home', range: (() => { const n = new Date(); return monthRange(n.getFullYear(), n.getMonth()); })(), tab: 'all', q: '', search: false };
const catById = id => S.cats.find(c => c.id === id) || S.cats.find(c => c.id === 'other') || S.cats[0];
const inRange = t => t.date >= U.range.from && t.date <= U.range.to;
function sums(list) { let inc = 0, exp = 0; for (const t of list) t.type === 'income' ? inc += t.amount : exp += t.amount; return { inc, exp }; }

function shiftRange(dir) {
  const r = U.range;
  if (isFullMonth(r)) { const d = toDate(r.from); U.range = monthRange(d.getFullYear(), d.getMonth() + dir); return; }
  const a = toDate(r.from), b = toDate(r.to), span = Math.round((b - a) / 864e5) + 1;
  a.setDate(a.getDate() + dir * span); b.setDate(b.getDate() + dir * span);
  U.range = { from: fromDate(a), to: fromDate(b) };
}

/* ============ recurring rules ============ */
function materialize() {
  const now = new Date(), endKey = now.getFullYear() * 12 + now.getMonth();
  let changed = false;
  for (const r of S.rules) {
    const s = toDate(r.start);
    for (let k = s.getFullYear() * 12 + s.getMonth(); k <= endKey; k++) {
      const y = Math.floor(k / 12), m = k % 12, key = `${y}-${pad(m + 1)}`;
      if (r.skip && r.skip.includes(key)) continue;
      if (S.txs.some(t => t.ruleId === r.id && t.ruleKey === key)) continue;
      const date = iso(y, m, Math.min(r.day, lastDay(y, m)));
      if (date < r.start) continue;
      S.txs.push({ id: uid(), type: r.type, amount: r.amount, date, catId: r.catId, kind: r.kind, detail: r.detail, note: r.note, ruleId: r.id, ruleKey: key });
      changed = true;
    }
  }
  if (changed) save();
}
function deleteRule(id) {
  const t0 = todayStr();
  S.txs = S.txs.filter(t => !(t.ruleId === id && t.date > t0));
  S.txs.forEach(t => { if (t.ruleId === id) { delete t.ruleId; delete t.ruleKey; } });
  S.rules = S.rules.filter(r => r.id !== id);
  save();
}

/* ============ rendering: pieces ============ */
const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  tx: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  budget: '<path d="M3 7a2 2 0 0 1 2-2h13v3"/><rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="16.5" cy="13.5" r="1.2"/>',
  reports: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>'
};
const NAV = [['home', 'בית'], ['tx', 'תנועות'], ['budget', 'תקציב'], ['reports', 'דוחות'], ['settings', 'הגדרות']];
const calIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg>';

function rangeBar() {
  return `<div class="rangebar"><button class="arr" data-act="prev" aria-label="הקודם">›</button>
  <button class="lbl" data-act="rangeSheet">${rangeLabel(U.range)} ${calIcon}</button>
  <button class="arr" data-act="next" aria-label="הבא">‹</button></div>`;
}
function header(title, right) {
  return `<header><span class="hb"></span><h1>${title}</h1>${right || '<span class="hb"></span>'}</header>`;
}
function txMeta(t) {
  if (t.type === 'income') {
    const k = INCOME_KINDS[t.kind] || INCOME_KINDS.other;
    return { icon: k.icon, color: '#2fd07f', title: k.name + (t.kind === 'other' && t.detail ? ` – ${t.detail}` : (t.note ? ` – ${t.note}` : '')), sub: '' };
  }
  const c = catById(t.catId);
  return { icon: c.icon, color: c.color, title: t.note || c.name, sub: t.note ? c.name : '' };
}
function txRow(t) {
  const m = txMeta(t);
  return `<button class="row" data-act="editTx" data-id="${t.id}">
    <span class="ico" style="background:${m.color}26">${m.icon}</span>
    <span class="rmid"><b>${esc(m.title)}</b><small>${m.sub ? esc(m.sub) + ' · ' : ''}${fmtD(t.date)}${t.ruleId ? '<span class="tag">קבועה</span>' : ''}</small></span>
    <span class="amt ${t.type}">${t.type === 'income' ? '+' : '-'}₪${nf.format(t.amount)}</span><span class="chev">‹</span></button>`;
}
function niceMax(v) {
  if (v <= 0) return 100;
  const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * e;
}
function roundTop(x, y, w, h, r) {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function monthSeq(y, m, n) { const out = []; for (let i = n - 1; i >= 0; i--) { const d = new Date(y, m - i, 1); out.push({ y: d.getFullYear(), m: d.getMonth() }); } return out; }
function bucketSums(seq, clip) {
  return seq.map(b => {
    let f = iso(b.y, b.m, 1), t = iso(b.y, b.m, lastDay(b.y, b.m));
    if (clip) { if (f < clip.from) f = clip.from; if (t > clip.to) t = clip.to; }
    return { ...b, ...sums(S.txs.filter(x => x.date >= f && x.date <= t)) };
  });
}
function trendChart(bk) {
  const W = 340, H = 176, L = 42, B = 22, T = 8, pw = W - L - 4, ph = H - B - T;
  const max = niceMax(Math.max(...bk.map(b => Math.max(b.inc, b.exp)), 0));
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const y = T + ph - ph * i / 4;
    g += `<line x1="${L}" x2="${W - 4}" y1="${y}" y2="${y}" stroke="#242a33" stroke-width="1"/><text x="${L - 6}" y="${y + 3.5}" text-anchor="end">${(max * i / 4).toLocaleString('en-US')}</text>`;
  }
  const gw = pw / bk.length, bw = Math.min(14, gw * 0.3);
  bk.forEach((b, i) => {
    const cx = L + gw * i + gw / 2, hi = ph * b.inc / max, he = ph * b.exp / max;
    const tip = `${MONTHS[b.m]} ${b.y}\nהכנסות: ${moneyT(b.inc)}\nהוצאות: ${moneyT(b.exp)}`;
    if (b.inc > 0) g += `<path d="${roundTop(cx - bw - 1, T + ph - hi, bw, hi, 4)}" fill="#2fd07f"/>`;
    if (b.exp > 0) g += `<path d="${roundTop(cx + 1, T + ph - he, bw, he, 4)}" fill="#f0626b"/>`;
    g += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${MSHORT[b.m]}</text><rect x="${L + gw * i}" y="${T}" width="${gw}" height="${ph + B}" fill="transparent" data-tip="${esc(tip)}"/>`;
  });
  return `<div class="lg2"><span><i style="background:#2fd07f"></i>הכנסות</span><span><i style="background:#f0626b"></i>הוצאות</span></div>
  <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="הכנסות מול הוצאות לפי חודש">${g}</svg>`;
}
function groupExpenses(list) {
  const m = new Map();
  for (const t of list) if (t.type === 'expense') { const c = catById(t.catId); const e = m.get(c.id) || { id: c.id, name: c.name, color: c.color, icon: c.icon, v: 0 }; e.v += t.amount; m.set(c.id, e); }
  return [...m.values()].sort((a, b) => b.v - a.v);
}
function donut(items, total) {
  const R = 46, C = 2 * Math.PI * R;
  let off = 0, segs = '';
  items.forEach(it => {
    const len = C * it.v / total, gap = items.length > 1 ? 2 : 0;
    segs += `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${it.color}" stroke-width="17" stroke-dasharray="${Math.max(len - gap, 0.5)} ${C}" stroke-dashoffset="${-off}" transform="rotate(-90 60 60)" data-tip="${esc(it.name + '\n' + moneyT(it.v) + ' (' + Math.round(100 * it.v / total) + '%)')}"/>`;
    off += len;
  });
  return `<div class="donut"><svg viewBox="0 0 120 120" role="img" aria-label="התפלגות הוצאות לפי קטגוריה"><circle cx="60" cy="60" r="${R}" fill="none" stroke="#1c2128" stroke-width="17"/>${segs}</svg>
  <div class="mid"><b>${money(total)}</b><small>סה״כ הוצאות</small></div></div>`;
}
function topItems(items, n) {
  if (items.length <= n) return items;
  const rest = items.slice(n - 1), v = rest.reduce((s, x) => s + x.v, 0);
  return items.slice(0, n - 1).concat([{ id: '_more', name: 'קטגוריות נוספות', color: '#5b6573', v }]);
}
function catCard(list, exp) {
  const items = groupExpenses(list);
  if (!items.length) return `<div class="card"><h3>הוצאות לפי קטגוריה</h3><div class="empty" style="padding:18px">אין הוצאות בטווח שנבחר</div></div>`;
  const top = topItems(items, 7);
  return `<div class="card"><div class="donutwrap">${donut(top, exp)}<div class="legend">${top.map(it =>
    `<div class="li"><span class="dot" style="background:${it.color}"></span><span class="n">${esc(it.name)}</span><span class="p">${Math.round(100 * it.v / exp)}%</span></div>`).join('')}</div></div></div>`;
}
function hbars(items, total) {
  const max = Math.max(...items.map(i => i.v), 1);
  return items.map(it => `<div class="hb2"><span class="n">${esc(it.name)}</span><span class="bar"><i style="width:${Math.max(2, 100 * it.v / max)}%;background:${it.color}"></i></span><span class="v">₪${nf.format(it.v)} · ${Math.round(100 * it.v / total)}%</span></div>`).join('');
}

/* ============ pages ============ */
function pageHome() {
  const list = S.txs.filter(inRange), { inc, exp } = sums(list), bal = inc - exp;
  if (!S.txs.length) {
    return header('הכנסות והוצאות') + rangeBar() + `<div class="card empty"><div class="big">💸</div><div style="font-size:18px;color:var(--tx);font-weight:600;margin-bottom:6px">אין עדיין תנועות</div>
    <div style="margin-bottom:16px">הוסף את התנועה הראשונה שלך, או טען נתוני דוגמה כדי לראות איך זה נראה.</div>
    <div class="acts" style="margin-top:0"><button class="btn" data-act="addTx">הוספת תנועה +</button></div>
    <div class="acts"><button class="btn sec" data-act="demo">טען נתוני דוגמה</button></div></div>`;
  }
  const to = toDate(U.range.to), bk = bucketSums(monthSeq(to.getFullYear(), to.getMonth(), 6));
  return header('הכנסות והוצאות') + rangeBar() + `
  <div class="card"><div class="sum"><div><small class="inc">הכנסות</small><b class="inc">${money(inc)}</b></div><div class="sep"></div><div><small class="exp">הוצאות</small><b class="exp">${money(exp)}</b></div></div>
  <div class="bal ${bal < 0 ? 'neg' : ''}"><small>יתרה בטווח</small><b class="${bal < 0 ? 'exp' : 'inc'}">${bal < 0 ? '-' : ''}${money(Math.abs(bal))} ${bal < 0 ? '↘' : '↗'}</b></div></div>
  ${catCard(list, exp)}
  <div class="card"><h3>מגמה חודשית</h3>${trendChart(bk)}</div>
  <button class="btn addbtn" data-act="addTx">הוספת תנועה +</button>`;
}
function pageTx() {
  let list = S.txs.filter(inRange);
  if (U.tab !== 'all') list = list.filter(t => t.type === (U.tab === 'inc' ? 'income' : 'expense'));
  const q = U.q.trim().toLowerCase();
  if (q) list = list.filter(t => { const m = txMeta(t); return (m.title + ' ' + m.sub + ' ' + t.amount + ' ' + fmtD(t.date)).toLowerCase().includes(q); });
  list.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const sIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
  return header('תנועות', `<button class="hb" data-act="toggleSearch" aria-label="חיפוש">${sIcon}</button>`) + rangeBar() +
    `<div class="tabs"><button class="${U.tab === 'all' ? 'on' : ''}" data-act="tab" data-v="all">הכל</button><button class="${U.tab === 'exp' ? 'on' : ''}" data-act="tab" data-v="exp">הוצאות</button><button class="${U.tab === 'inc' ? 'on' : ''}" data-act="tab" data-v="inc">הכנסות</button></div>` +
    (U.search ? `<input class="srch" id="q" type="search" placeholder="חיפוש לפי תיאור, קטגוריה או סכום" value="${esc(U.q)}">` : '') +
    (list.length ? `<div class="list">${list.map(txRow).join('')}</div>` : `<div class="empty"><div class="big">🗂️</div>אין תנועות בטווח שנבחר</div>`) +
    `<button class="btn addbtn" data-act="addTx" data-type="${U.tab === 'inc' ? 'income' : 'expense'}">${U.tab === 'inc' ? 'הוספת הכנסה' : 'הוספת הוצאה'} +</button>`;
}
function pageBudget() {
  const list = S.txs.filter(inRange), mult = monthsInRange(U.range), spent = {};
  list.forEach(t => { if (t.type === 'expense') spent[t.catId] = (spent[t.catId] || 0) + t.amount; });
  const cats = S.cats.filter(c => c.id !== 'invest' || true);
  let totB = 0, totS = 0;
  const rows = cats.map(c => {
    const b = Number(S.budgets[c.id]) || 0, s = spent[c.id] || 0, lim = b * mult;
    if (b) { totB += lim; totS += s; }
    const p = lim ? s / lim : 0, col = p > 1 ? '#f0626b' : p > 0.85 ? '#c98500' : '#2fd07f';
    return `<div class="brow"><div class="top"><span class="ico" style="background:${c.color}26">${c.icon}</span><span class="nm">${esc(c.name)}</span>
      <input type="number" inputmode="decimal" min="0" placeholder="תקציב חודשי" value="${b || ''}" data-budget="${c.id}" aria-label="תקציב חודשי ל${esc(c.name)}"></div>
      ${b ? `<div class="prog"><i style="width:${Math.min(100, p * 100)}%;background:${col}"></i></div><small>הוצא ₪${nf.format(s)} מתוך ₪${nf.format(Math.round(lim))} · ${p > 1 ? `חריגה של ₪${nf.format(Math.round(s - lim))}` : `נותר ₪${nf.format(Math.round(lim - s))}`}</small>` : `<small>הוצא ₪${nf.format(s)} · לא הוגדר תקציב</small>`}</div>`;
  }).join('');
  return header('תקציב') + rangeBar() + `<div class="card"><div class="stat3"><div><small>תקציב לטווח</small><b>${money(Math.round(totB))}</b></div><div><small>הוצא (בקטגוריות עם תקציב)</small><b class="${totS > totB && totB ? 'exp' : ''}">${money(totS)}</b></div><div><small>נותר</small><b class="${totB - totS < 0 ? 'exp' : 'inc'}">${totB - totS < 0 ? '-' : ''}${money(Math.abs(Math.round(totB - totS)))}</b></div></div></div>
  <div class="card"><h3>תקציב חודשי לפי קטגוריה</h3>${rows}</div><div class="note">התקציב מוגדר לחודש, ומחושב באופן יחסי לאורך הטווח שנבחר.</div>`;
}
function pageReports() {
  const list = S.txs.filter(inRange), { inc, exp } = sums(list), bal = inc - exp;
  const to = toDate(U.range.to), from = toDate(U.range.from);
  const n = (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth() + 1;
  const bk = n >= 3 ? bucketSums(monthSeq(to.getFullYear(), to.getMonth(), Math.min(n, 12)), U.range) : bucketSums(monthSeq(to.getFullYear(), to.getMonth(), 6));
  const cats = groupExpenses(list);
  const incMap = {}; list.filter(t => t.type === 'income').forEach(t => { incMap[t.kind] = (incMap[t.kind] || 0) + t.amount; });
  const incItems = Object.entries(incMap).map(([k, v]) => ({ name: (INCOME_KINDS[k] || INCOME_KINDS.other).name, v, color: '#2fd07f' })).sort((a, b) => b.v - a.v);
  const rate = inc > 0 ? Math.round(100 * bal / inc) : 0, avg = exp / Math.max(1, monthsInRange(U.range));
  return header('דוחות') + rangeBar() + `
  <div class="card"><div class="stat3"><div><small>הכנסות</small><b class="inc">${money(inc)}</b></div><div><small>הוצאות</small><b class="exp">${money(exp)}</b></div><div><small>יתרה</small><b class="${bal < 0 ? 'exp' : 'inc'}">${bal < 0 ? '-' : ''}${money(Math.abs(bal))}</b></div></div>
  <div class="note" style="margin:12px 0 0;text-align:center">שיעור חיסכון: <b style="color:var(--tx)">${rate}%</b> · ממוצע הוצאות חודשי: <b style="color:var(--tx)">${money(Math.round(avg))}</b></div></div>
  <div class="card"><h3>הכנסות מול הוצאות לפי חודש</h3>${trendChart(bk)}</div>
  ${catCard(list, exp)}
  <div class="card"><h3>פירוט הוצאות</h3>${cats.length ? hbars(cats, exp) : '<div class="empty" style="padding:14px">אין הוצאות בטווח</div>'}</div>
  <div class="card"><h3>הכנסות לפי סוג</h3>${incItems.length ? hbars(incItems, inc) : '<div class="empty" style="padding:14px">אין הכנסות בטווח</div>'}</div>`;
}
function pageSettings() {
  const rules = S.rules.slice().sort((a, b) => a.day - b.day);
  return header('הגדרות') + `
  <div class="card"><h3>החשבון</h3><div class="setrow"><span class="m" dir="ltr" style="text-align:right">${esc(currentUser ? currentUser.email : '')}<small style="direction:rtl">מחובר · הנתונים נשמרים בענן</small></span></div><div class="acts" style="margin-top:8px"><button class="btn sec" data-act="logout">התנתקות</button></div></div>
  <div class="card"><h3>קטגוריות הוצאה <button class="btn sm sec" data-act="newCat">+ קטגוריה</button></h3>
  ${S.cats.map(c => `<button class="setrow" data-act="editCat" data-id="${c.id}"><span class="ico" style="background:${c.color}26">${c.icon}</span><span class="m">${esc(c.name)}</span><span class="chev" style="color:#555e6c">‹</span></button>`).join('')}</div>
  <div class="card"><h3>הוצאות והכנסות קבועות</h3>
  ${rules.length ? rules.map(r => { const m = txMeta(r); return `<button class="setrow" data-act="editRule" data-id="${r.id}"><span class="ico" style="background:${m.color}26">${m.icon}</span><span class="m">${esc(m.title)}<small>כל חודש ב-${r.day} · מ-${fmtD(r.start)}</small></span><span class="${r.type === 'income' ? 'inc' : 'exp'}" style="font-weight:600">${r.type === 'income' ? '+' : '-'}₪${nf.format(r.amount)}</span></button>`; }).join('') : '<div class="note">אין עדיין תנועות קבועות. בעת הוספת תנועה, הפעל את המתג "חוזרת כל חודש".</div>'}</div>
  <div class="card"><h3>נתונים</h3>
  <div class="acts" style="margin-top:0"><button class="btn sec" data-act="exportData">ייצוא / ייבוא גיבוי</button></div>
  <div class="acts"><button class="btn sec" data-act="demo">טען נתוני דוגמה</button></div>
  <div class="acts"><button class="btn danger" data-act="wipe">מחיקת כל הנתונים</button></div>
  <div class="note">הנתונים שלך מאוחסנים בחשבון ומוגנים בהרשאות ברמת שורה. אפשר לייצא גיבוי בכל עת.</div></div>`;
}
const PAGES = { home: pageHome, tx: pageTx, budget: pageBudget, reports: pageReports, settings: pageSettings };

function render() {
  const sy = window.scrollY, active = document.activeElement && document.activeElement.id;
  const html = PAGES[U.page]();
  const nav = `<nav>${NAV.map(([k, n]) => `<button class="${U.page === k ? 'on' : ''}" data-act="nav" data-v="${k}"><svg viewBox="0 0 24 24">${ICONS[k]}</svg>${n}</button>`).join('')}</nav>`;
  document.getElementById('app').innerHTML = html + nav;
  window.scrollTo(0, sy);
  if (active === 'q') { const q = document.getElementById('q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
}

/* ============ sheets ============ */
let F = null, CB = [];
const layer = () => document.getElementById('layer');
function openSheet(html) {
  layer().innerHTML = `<div class="sheetbg" data-act="bg"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  document.body.style.overflow = 'hidden';
}
function closeSheet() { layer().innerHTML = ''; document.body.style.overflow = ''; F = null; CB = []; }
function toast(msg) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg; document.body.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}
function confirmSheet(title, text, buttons) {
  CB = buttons.map(b => b.fn);
  openSheet(`<h2>${esc(title)}<button class="x" data-act="close" aria-label="סגירה">×</button></h2><div class="note" style="font-size:14px;margin-bottom:6px">${esc(text)}</div>
  <div class="acts" style="flex-direction:column">${buttons.map((b, i) => `<button class="btn ${b.cls || 'sec'}" data-act="cb" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`);
}

/* --- add / edit transaction --- */
function txSheet(t, type) {
  const base = t ? { id: t.id, type: t.type, amount: String(t.amount), date: t.date, catId: t.catId || 'food', kind: t.kind || 'salary', detail: t.detail || '', note: t.note || '', ruleId: t.ruleId, recurring: !!t.ruleId }
    : { id: null, type: type || 'expense', amount: '', date: todayStr(), catId: 'food', kind: 'salary', detail: '', note: '', recurring: false };
  F = base; renderTxSheet(true);
}
function renderTxSheet(focus) {
  const f = F, isE = f.type === 'expense';
  openSheet(`<h2>${f.id ? 'עריכת תנועה' : 'תנועה חדשה'}<button class="x" data-act="close" aria-label="סגירה">×</button></h2>
  <div class="seg"><button class="e ${isE ? 'on' : ''}" data-act="ftype" data-v="expense">הוצאה</button><button class="i ${!isE ? 'on' : ''}" data-act="ftype" data-v="income">הכנסה</button></div>
  <input class="amount" id="f_amount" data-f="amount" type="number" inputmode="decimal" step="0.01" min="0" placeholder="₪ 0" value="${esc(f.amount)}" aria-label="סכום">
  <label class="fl">תאריך</label><input type="date" data-f="date" value="${f.date}">
  ${isE ? `<label class="fl">קטגוריה</label><div class="chips">${S.cats.map(c => `<button class="chip ${f.catId === c.id ? 'on' : ''}" data-act="fcat" data-v="${c.id}"><span class="cd" style="background:${c.color}"></span>${c.icon} ${esc(c.name)}</button>`).join('')}</div>
    <label class="fl">תיאור (לא חובה)</label><input data-f="note" placeholder="למשל: שכירות עסק" value="${esc(f.note)}">`
  : `<label class="fl">סוג הכנסה</label><div class="chips">${Object.entries(INCOME_KINDS).map(([k, v]) => `<button class="chip ${f.kind === k ? 'on' : ''}" data-act="fkind" data-v="${k}">${v.icon} ${v.name}</button>`).join('')}</div>
    <label class="fl">${f.kind === 'other' ? 'פירוט (חובה)' : 'פירוט (לא חובה)'}</label><input data-f="${f.kind === 'other' ? 'detail' : 'note'}" placeholder="${f.kind === 'other' ? 'למשל: החזר מס, מתנה, עבודה צדדית' : 'הערה'}" value="${esc(f.kind === 'other' ? f.detail : f.note)}">`}
  <button class="tgl ${f.recurring ? 'on' : ''}" data-act="frec" style="width:100%;text-align:start" ${f.ruleId ? 'disabled' : ''}><span>חוזרת כל חודש<small>${f.ruleId ? 'תנועה קבועה – לעריכה/ביטול היכנס להגדרות' : 'תישמר ותתווסף אוטומטית בכל חודש עד שתערוך או תמחק'}</small></span><span class="sw"></span></button>
  <div class="acts">${f.id ? '<button class="btn danger" data-act="delTx" style="flex:0 0 38%">מחיקה</button>' : ''}<button class="btn" data-act="saveTx">${f.id ? 'שמירה' : 'הוספה'}</button></div>`);
  if (focus && !f.id) setTimeout(() => { const e = document.getElementById('f_amount'); e && e.focus(); }, 60);
}
function saveTx() {
  const f = F, amt = parseFloat(f.amount);
  if (!(amt > 0)) return toast('הזן סכום תקין');
  if (!f.date) return toast('בחר תאריך');
  if (f.type === 'income' && f.kind === 'other' && !f.detail.trim()) return toast('הוסף פירוט להכנסה מסוג "אחר"');
  const data = f.type === 'expense'
    ? { type: 'expense', amount: amt, date: f.date, catId: f.catId, note: f.note.trim() }
    : { type: 'income', amount: amt, date: f.date, kind: f.kind, detail: f.kind === 'other' ? f.detail.trim() : '', note: f.kind === 'other' ? '' : f.note.trim() };
  let t;
  if (f.id) {
    t = S.txs.find(x => x.id === f.id);
    for (const k of ['catId', 'kind', 'detail', 'note']) delete t[k];
    Object.assign(t, data);
  } else { t = { id: uid(), ...data }; S.txs.push(t); }
  if (f.recurring && !t.ruleId) {
    const d = toDate(t.date), rid = uid();
    S.rules.push({ id: rid, type: t.type, amount: t.amount, catId: t.catId, kind: t.kind, detail: t.detail, note: t.note, day: d.getDate(), start: t.date });
    t.ruleId = rid; t.ruleKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    materialize();
  }
  save(); closeSheet(); render(); toast(f.id ? 'נשמר' : 'התנועה נוספה');
}
function deleteTx(id) {
  const t = S.txs.find(x => x.id === id); if (!t) return;
  const only = () => { if (t.ruleId) { const r = S.rules.find(r => r.id === t.ruleId); if (r) (r.skip = r.skip || []).push(t.ruleKey); } S.txs = S.txs.filter(x => x.id !== id); save(); closeSheet(); render(); toast('נמחק'); };
  if (t.ruleId && S.rules.some(r => r.id === t.ruleId)) {
    confirmSheet('מחיקת תנועה קבועה', 'התנועה הזו נוצרה מתנועה קבועה. מה למחוק?', [
      { label: 'רק את התנועה הזו', fn: only },
      { label: 'את הקבועה (ולהפסיק חיובים עתידיים)', cls: 'danger', fn: () => { deleteRule(t.ruleId); S.txs = S.txs.filter(x => x.id !== id); save(); closeSheet(); render(); toast('הקבועה נמחקה'); } },
      { label: 'ביטול', fn: closeSheet }]);
  } else confirmSheet('מחיקת תנועה', 'למחוק את התנועה? לא ניתן לשחזר.', [{ label: 'מחק', cls: 'danger', fn: only }, { label: 'ביטול', fn: closeSheet }]);
}

/* --- range --- */
function rangeSheet() {
  F = { from: U.range.from, to: U.range.to };
  const n = new Date(), y = n.getFullYear(), m = n.getMonth();
  const P = [['החודש', () => monthRange(y, m)], ['חודש קודם', () => monthRange(y, m - 1)],
    ['30 ימים אחרונים', () => { const a = new Date(); a.setDate(a.getDate() - 29); return { from: fromDate(a), to: todayStr() }; }],
    ['3 חודשים אחרונים', () => ({ from: monthRange(y, m - 2).from, to: monthRange(y, m).to })],
    ['השנה', () => ({ from: iso(y, 0, 1), to: iso(y, 11, 31) })],
    ['שנה אחרונה', () => ({ from: monthRange(y, m - 11).from, to: monthRange(y, m).to })],
    ['הכל', () => { const ds = S.txs.map(t => t.date).sort(); return { from: ds[0] || monthRange(y, m).from, to: ds.length ? (ds[ds.length - 1] > todayStr() ? ds[ds.length - 1] : todayStr()) : monthRange(y, m).to }; }]];
  CB = P.map(p => () => { U.range = p[1](); closeSheet(); render(); });
  openSheet(`<h2>בחירת טווח תאריכים<button class="x" data-act="close" aria-label="סגירה">×</button></h2>
  <div class="chips">${P.map((p, i) => `<button class="chip" data-act="cb" data-i="${i}">${p[0]}</button>`).join('')}</div>
  <label class="fl">מתאריך</label><input type="date" data-f="from" value="${F.from}">
  <label class="fl">עד תאריך</label><input type="date" data-f="to" value="${F.to}">
  <div class="acts"><button class="btn" data-act="applyRange">החל</button></div>`);
}

/* --- categories --- */
function catSheet(c) {
  F = c ? { ...c, isNew: false } : { id: null, name: '', icon: '📦', color: CAT_COLORS[S.cats.length % CAT_COLORS.length], isNew: true };
  renderCatSheet();
}
function renderCatSheet() {
  const f = F;
  openSheet(`<h2>${f.isNew ? 'קטגוריה חדשה' : 'עריכת קטגוריה'}<button class="x" data-act="close" aria-label="סגירה">×</button></h2>
  <label class="fl" style="margin-top:0">שם</label><input data-f="name" value="${esc(f.name)}" placeholder="למשל: חינוך" maxlength="30">
  <label class="fl">אייקון</label><div class="emo">${EMOJIS.map(e => `<button class="${f.icon === e ? 'on' : ''}" data-act="cicon" data-v="${e}">${e}</button>`).join('')}</div>
  <label class="fl">צבע</label><div class="sw8">${CAT_COLORS.map(c => `<button class="${f.color === c ? 'on' : ''}" style="background:${c}" data-act="ccolor" data-v="${c}" aria-label="צבע ${c}"></button>`).join('')}</div>
  <div class="acts">${!f.isNew && f.id !== 'other' ? '<button class="btn danger" data-act="delCat" style="flex:0 0 38%">מחיקה</button>' : ''}<button class="btn" data-act="saveCat">שמירה</button></div>`);
}
function saveCat() {
  const f = F, name = f.name.trim();
  if (!name) return toast('הזן שם לקטגוריה');
  if (f.isNew) S.cats.push({ id: uid(), name, icon: f.icon, color: f.color });
  else Object.assign(S.cats.find(c => c.id === f.id), { name, icon: f.icon, color: f.color });
  save(); closeSheet(); render(); toast('נשמר');
}
function deleteCat(id) {
  const used = S.txs.filter(t => t.catId === id).length;
  confirmSheet('מחיקת קטגוריה', used ? `יש ${used} תנועות בקטגוריה. הן יועברו לקטגוריה "אחר".` : 'למחוק את הקטגוריה?', [
    { label: 'מחק', cls: 'danger', fn: () => { S.txs.forEach(t => { if (t.catId === id) t.catId = 'other'; }); S.rules.forEach(r => { if (r.catId === id) r.catId = 'other'; }); delete S.budgets[id]; S.cats = S.cats.filter(c => c.id !== id); save(); closeSheet(); render(); } },
    { label: 'ביטול', fn: closeSheet }]);
}

/* --- rules --- */
function ruleSheet(r) {
  F = { id: r.id, type: r.type, amount: String(r.amount), day: String(r.day), catId: r.catId || 'food', kind: r.kind || 'salary', note: r.note || '', detail: r.detail || '' };
  const f = F, isE = f.type === 'expense';
  openSheet(`<h2>${isE ? 'הוצאה קבועה' : 'הכנסה קבועה'}<button class="x" data-act="close" aria-label="סגירה">×</button></h2>
  <label class="fl" style="margin-top:0">סכום</label><input type="number" inputmode="decimal" step="0.01" data-f="amount" value="${esc(f.amount)}">
  <label class="fl">יום בחודש</label><input type="number" min="1" max="31" data-f="day" value="${esc(f.day)}">
  ${isE ? `<label class="fl">קטגוריה</label><div class="chips">${S.cats.map(c => `<button class="chip ${f.catId === c.id ? 'on' : ''}" data-act="rcat" data-v="${c.id}"><span class="cd" style="background:${c.color}"></span>${c.icon} ${esc(c.name)}</button>`).join('')}</div>
  <label class="fl">תיאור</label><input data-f="note" value="${esc(f.note)}">` : `<label class="fl">פירוט</label><input data-f="${f.kind === 'other' ? 'detail' : 'note'}" value="${esc(f.kind === 'other' ? f.detail : f.note)}">`}
  <div class="note" style="margin-top:12px">השינוי יחול מהחודש הנוכחי והלאה. תנועות מחודשים קודמים נשארות כפי שהיו.</div>
  <div class="acts"><button class="btn danger" data-act="delRule" style="flex:0 0 38%">מחיקה</button><button class="btn" data-act="saveRule">שמירה</button></div>`);
}
function saveRule() {
  const f = F, r = S.rules.find(x => x.id === f.id), amt = parseFloat(f.amount), day = parseInt(f.day, 10);
  if (!(amt > 0)) return toast('הזן סכום תקין');
  if (!(day >= 1 && day <= 31)) return toast('יום בחודש בין 1 ל-31');
  Object.assign(r, { amount: amt, day, catId: f.catId, note: f.note, detail: f.detail });
  const n = new Date(), from = iso(n.getFullYear(), n.getMonth(), 1);
  S.txs.forEach(t => {
    if (t.ruleId !== r.id || t.date < from) return;
    const d = toDate(t.date); t.amount = amt; t.catId = r.catId; t.note = r.note; t.detail = r.detail;
    t.date = iso(d.getFullYear(), d.getMonth(), Math.min(day, lastDay(d.getFullYear(), d.getMonth())));
  });
  save(); closeSheet(); render(); toast('הקבועה עודכנה');
}

/* --- data --- */
function exportSheet() {
  openSheet(`<h2>גיבוי נתונים<button class="x" data-act="close" aria-label="סגירה">×</button></h2>
  <label class="fl" style="margin-top:0">ייצוא – העתק ושמור במקום בטוח</label><textarea id="exp" readonly>${esc(JSON.stringify(S))}</textarea>
  <div class="acts" style="margin-top:8px"><button class="btn sec" data-act="copyExp">העתקה</button></div>
  <label class="fl">ייבוא – הדבק גיבוי (יחליף את הנתונים הקיימים)</label><textarea id="imp" placeholder="הדבק כאן"></textarea>
  <div class="acts" style="margin-top:8px"><button class="btn" data-act="doImport">ייבוא</button></div>`);
}
function doImport() {
  try {
    const d = JSON.parse(document.getElementById('imp').value);
    if (!d || !Array.isArray(d.txs) || !Array.isArray(d.cats)) throw 0;
    S = { v: 1, txs: d.txs, cats: d.cats, rules: d.rules || [], budgets: d.budgets || {} };
    save(); closeSheet(); render(); toast('הנתונים יובאו');
  } catch (e) { toast('הגיבוי אינו תקין'); }
}
function loadDemo() {
  const go = () => {
    let seed = 7; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    S = { v: 1, txs: [], cats: DEFAULT_CATS.map(c => ({ ...c })), rules: [], budgets: { housing: 2500, car: 1700, food: 3500, bills: 1200, insurance: 600, fun: 1200 } };
    const n = new Date(), s0 = monthRange(n.getFullYear(), n.getMonth() - 5).from;
    const R = (type, amount, day, extra) => S.rules.push({ id: uid(), type, amount, day, start: s0, ...extra });
    R('income', 16000, 10, { kind: 'salary', note: '' });
    R('expense', 2500, 1, { catId: 'housing', note: 'שכירות' });
    R('expense', 1650, 2, { catId: 'car', note: 'החזר הלוואה לרכב' });
    R('expense', 750, 5, { catId: 'invest', note: 'קרן השתלמות' });
    R('expense', 500, 5, { catId: 'insurance', note: 'ביטוח רכב' });
    R('expense', 400, 12, { catId: 'bills', note: 'חשמל' });
    R('expense', 170, 12, { catId: 'bills', note: 'אינטרנט' });
    R('expense', 70, 15, { catId: 'fun', note: 'Netflix' });
    for (let i = 5; i >= 0; i--) {
      const d = new Date(n.getFullYear(), n.getMonth() - i, 1), y = d.getFullYear(), m = d.getMonth();
      const add = (day, type, amount, extra) => { const date = iso(y, m, Math.min(day, lastDay(y, m))); if (date <= todayStr()) S.txs.push({ id: uid(), type, amount: Math.round(amount), date, ...extra }); };
      for (let w = 0; w < 4; w++) add(3 + w * 7, 'expense', 250 + rnd() * 350, { catId: 'food', note: ['שופרסל', 'רמי לוי', 'ירקות', 'מאפייה'][w] });
      add(10, 'expense', 300 + rnd() * 400, { catId: 'car', note: 'דלק' });
      add(18, 'expense', 120 + rnd() * 380, { catId: 'fun', note: 'מסעדה' });
      if (rnd() > 0.55) add(20, 'income', 1200 + rnd() * 1200, { kind: 'reserve', detail: '', note: 'מילואים' });
      if (rnd() > 0.8) add(22, 'income', 400 + rnd() * 600, { kind: 'other', detail: 'עבודה צדדית' });
    }
    materialize(); save(); closeSheet(); U.page = 'home'; render(); toast('נטענו נתוני דוגמה');
  };
  if (S.txs.length) confirmSheet('טעינת נתוני דוגמה', 'הפעולה תחליף את כל הנתונים הקיימים. להמשיך?', [{ label: 'כן, החלף', cls: 'danger', fn: go }, { label: 'ביטול', fn: closeSheet }]); else go();
}

/* ============ events ============ */
const ACT = {
  nav: e => { U.page = e.dataset.v; window.scrollTo(0, 0); render(); },
  prev: () => { shiftRange(-1); render(); }, next: () => { shiftRange(1); render(); },
  rangeSheet, applyRange: () => { if (!F.from || !F.to) return toast('בחר תאריכים'); let { from, to } = F; if (from > to) [from, to] = [to, from]; U.range = { from, to }; closeSheet(); render(); },
  tab: e => { U.tab = e.dataset.v; render(); },
  toggleSearch: () => { U.search = !U.search; if (!U.search) U.q = ''; render(); const q = document.getElementById('q'); q && q.focus(); },
  addTx: e => txSheet(null, e.dataset.type),
  editTx: e => txSheet(S.txs.find(t => t.id === e.dataset.id)),
  ftype: e => { F.type = e.dataset.v; renderTxSheet(); },
  fcat: e => { F.catId = e.dataset.v; renderTxSheet(); },
  fkind: e => { F.kind = e.dataset.v; renderTxSheet(); },
  frec: () => { if (F.ruleId) return; F.recurring = !F.recurring; renderTxSheet(); },
  saveTx, delTx: () => deleteTx(F.id),
  newCat: () => catSheet(null), editCat: e => catSheet(S.cats.find(c => c.id === e.dataset.id)),
  cicon: e => { F.icon = e.dataset.v; renderCatSheet(); }, ccolor: e => { F.color = e.dataset.v; renderCatSheet(); },
  saveCat, delCat: () => deleteCat(F.id),
  editRule: e => ruleSheet(S.rules.find(r => r.id === e.dataset.id)),
  rcat: e => { F.catId = e.dataset.v; ruleSheet2(); },
  saveRule, delRule: () => { const id = F.id; confirmSheet('מחיקת תנועה קבועה', 'התנועה תיפסק מהחודש הבא. תנועות שכבר נרשמו עד היום יישארו.', [{ label: 'מחק', cls: 'danger', fn: () => { deleteRule(id); closeSheet(); render(); toast('נמחקה'); } }, { label: 'ביטול', fn: closeSheet }]); },
  exportData: exportSheet, copyExp: () => { const t = document.getElementById('exp'); t.select(); try { navigator.clipboard.writeText(t.value).then(() => toast('הועתק'), () => toast('סמן והעתק ידנית')); } catch (e) { toast('סמן והעתק ידנית'); } },
  doImport, demo: loadDemo,
  wipe: () => confirmSheet('מחיקת כל הנתונים', 'כל התנועות, הקטגוריות והתקציבים יימחקו לצמיתות.', [{ label: 'מחק הכל', cls: 'danger', fn: () => { S = { v: 1, txs: [], cats: DEFAULT_CATS.map(c => ({ ...c })), rules: [], budgets: {} }; save(); closeSheet(); U.page = 'home'; render(); } }, { label: 'ביטול', fn: closeSheet }]),
  logout: async () => { try { if (sync) await sync.flush(); } catch (e) {} await supabase.auth.signOut(); },
  close: closeSheet,
  cb: e => { const fn = CB[+e.dataset.i]; fn && fn(); },
  bg: () => { }
};
function ruleSheet2() { /* re-render rule sheet keeping edits */ const r = { ...F }; ruleSheet({ id: r.id, type: r.type, amount: r.amount, day: r.day, catId: r.catId, kind: r.kind, note: r.note, detail: r.detail }); F = r; }
document.addEventListener('click', e => {
  const bg = e.target.closest('.sheetbg');
  if (bg && e.target === bg) return closeSheet();
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = ACT[el.dataset.act]; if (fn) fn(el);
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.f && F) F[t.dataset.f] = t.value;
  else if (t.id === 'q') { U.q = t.value; render(); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.budget) { const v = parseFloat(t.value); if (v > 0) S.budgets[t.dataset.budget] = v; else delete S.budgets[t.dataset.budget]; save(); render(); }
});
/* tooltip */
let tipEl = null;
function showTip(el, x, y) {
  hideTip(); tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.textContent = el.dataset.tip; document.body.appendChild(tipEl);
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  tipEl.style.left = Math.max(6, Math.min(innerWidth - w - 6, x - w / 2)) + 'px';
  tipEl.style.top = Math.max(6, y - h - 14) + 'px';
}
function hideTip() { if (tipEl) { tipEl.remove(); tipEl = null; } }
document.addEventListener('pointerover', e => { const el = e.target.closest('[data-tip]'); if (el && e.pointerType === 'mouse') showTip(el, e.clientX, e.clientY); });
document.addEventListener('pointermove', e => { if (tipEl && e.pointerType === 'mouse') { const el = e.target.closest('[data-tip]'); el ? showTip(el, e.clientX, e.clientY) : hideTip(); } });
document.addEventListener('click', e => { const el = e.target.closest('[data-tip]'); el ? showTip(el, e.clientX, e.clientY) : hideTip(); });
window.addEventListener('scroll', hideTip, { passive: true });


/* ============ boot: auth + data ============ */
let recovering = false, starting = false;
async function startApp(user) {
  if (starting || (currentUser && currentUser.id === user.id)) return;
  starting = true;
  try {
    document.getElementById('app').innerHTML = '<div class="authwrap"><div class="empty">טוען נתונים…</div></div>';
    const loaded = await loadAll(user.id, DEFAULT_CATS);
    S = loaded; currentUser = user;
    sync = createSync(user.id, () => S, e => { console.error(e); toast('שגיאת סנכרון – ננסה שוב'); });
    sync.prime(S);
    U.page = 'home'; materialize(); render();
  } catch (e) {
    console.error(e);
    document.getElementById('app').innerHTML = `<div class="authwrap"><div class="card empty"><div class="big">⚠️</div>לא הצלחנו לטעון את הנתונים.<br><small>${esc(e.message || e)}</small><div class="acts"><button class="btn sec" data-act="reload">נסה שוב</button></div></div></div>`;
  } finally { starting = false; }
}
function stopApp() { sync = null; currentUser = null; S = emptyState(); closeSheet(); }
ACT.reload = () => location.reload();

if (!configured) {
  document.getElementById('app').innerHTML = `<div class="authwrap"><div class="card"><h3>חסרה הגדרת Supabase</h3><div class="note" style="font-size:14px;line-height:1.7">צור קובץ <b dir="ltr">config.js</b> לפי <b dir="ltr">config.example.js</b> עם <b dir="ltr">SUPABASE_URL</b> ו-<b dir="ltr">SUPABASE_ANON_KEY</b>, ורענן את הדף.</div></div></div>`;
} else {
  window.addEventListener('pagehide', () => { if (sync) sync.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && sync) sync.flush(); });
  supabase.auth.onAuthStateChange((event, session) => {
    // never await supabase calls inside this callback
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') { recovering = true; showRecovery(supabase, () => { recovering = false; if (session) startApp(session.user); }); return; }
      if (recovering) return;
      if (!session) { stopApp(); showAuth(supabase); return; }
      startApp(session.user);
    }, 0);
  });
}
