import { supabase } from './supabase.js';

const PAGE = 1000;
const TABLES = ['categories', 'transactions', 'recurring_rules', 'budgets'];
const KEY = { categories: r => r.id, transactions: r => r.id, recurring_rules: r => r.id, budgets: r => r.cat_id };
const KEY_COL = { categories: 'id', transactions: 'id', recurring_rules: 'id', budgets: 'cat_id' };
const CONFLICT = { categories: 'user_id,id', transactions: 'user_id,id', recurring_rules: 'user_id,id', budgets: 'user_id,cat_id' };
const ORDER = { categories: 'sort', transactions: 'id', recurring_rules: 'id', budgets: 'cat_id' };

/* ---------- row <-> app object mapping ---------- */
const nn = v => (v === undefined || v === '' ? null : v);

const toRows = (S, uid) => ({
  categories: S.cats.map((c, i) => ({ user_id: uid, id: c.id, name: c.name, icon: c.icon, color: c.color, sort: i })),
  transactions: S.txs.map(t => ({
    user_id: uid, id: t.id, type: t.type, amount: t.amount, date: t.date,
    cat_id: nn(t.catId), kind: nn(t.kind), detail: nn(t.detail), note: nn(t.note),
    rule_id: nn(t.ruleId), rule_key: nn(t.ruleKey)
  })),
  recurring_rules: S.rules.map(r => ({
    user_id: uid, id: r.id, type: r.type, amount: r.amount, cat_id: nn(r.catId), kind: nn(r.kind),
    detail: nn(r.detail), note: nn(r.note), day: r.day, rule_start: r.start, skip: r.skip || []
  })),
  budgets: Object.entries(S.budgets).map(([cat_id, amount]) => ({ user_id: uid, cat_id, amount }))
});

const fromTx = r => {
  const t = { id: r.id, type: r.type, amount: Number(r.amount), date: r.date, detail: r.detail || '', note: r.note || '' };
  if (r.cat_id) t.catId = r.cat_id;
  if (r.kind) t.kind = r.kind;
  if (r.rule_id) { t.ruleId = r.rule_id; t.ruleKey = r.rule_key; }
  return t;
};
const fromRule = r => {
  const x = { id: r.id, type: r.type, amount: Number(r.amount), day: r.day, start: r.rule_start, detail: r.detail || '', note: r.note || '' };
  if (r.cat_id) x.catId = r.cat_id;
  if (r.kind) x.kind = r.kind;
  if (r.skip && r.skip.length) x.skip = r.skip;
  return x;
};

/* ---------- loading ---------- */
async function fetchAll(table, uid) {
  let out = [], from = 0;
  for (;;) {
    const { data, error } = await supabase.from(table).select('*').eq('user_id', uid)
      .order(ORDER[table], { ascending: true }).range(from, from + PAGE - 1);
    if (error) throw error;
    out = out.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

export async function loadAll(uid, defaultCats) {
  const [cats, txs, rules, budgets] = await Promise.all(TABLES.map(t => fetchAll(t, uid)));
  let catList = cats.map(c => ({ id: c.id, name: c.name, icon: c.icon, color: c.color }));
  if (!catList.length) {
    // first login of a new user: seed default categories
    catList = defaultCats.map(c => ({ ...c }));
    const { error } = await supabase.from('categories').upsert(toRows({ cats: catList, txs: [], rules: [], budgets: {} }, uid).categories, { onConflict: CONFLICT.categories });
    if (error) throw error;
  }
  return {
    v: 1,
    cats: catList,
    txs: txs.map(fromTx),
    rules: rules.map(fromRule),
    budgets: Object.fromEntries(budgets.map(b => [b.cat_id, Number(b.amount)]))
  };
}

/* ---------- saving: diff the in-memory state against the last synced snapshot ---------- */
export function createSync(uid, getState, onError) {
  let snap = Object.fromEntries(TABLES.map(t => [t, new Map()]));
  let timer = null, running = null, again = false;

  const snapshotOf = rows => Object.fromEntries(TABLES.map(t => [t, new Map(rows[t].map(r => [KEY[t](r), JSON.stringify(r)]))]));
  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

  async function run() {
    do {
      again = false;
      const rows = toRows(getState(), uid), cur = snapshotOf(rows);
      for (const t of TABLES) {
        const up = rows[t].filter(r => snap[t].get(KEY[t](r)) !== cur[t].get(KEY[t](r)));
        const del = [...snap[t].keys()].filter(k => !cur[t].has(k));
        for (const c of chunk(up, 500)) {
          const { error } = await supabase.from(t).upsert(c, { onConflict: CONFLICT[t] });
          if (error) throw error;
        }
        for (const c of chunk(del, 200)) {
          const { error } = await supabase.from(t).delete().eq('user_id', uid).in(KEY_COL[t], c);
          if (error) throw error;
        }
        snap[t] = cur[t]; // advance only after this table fully succeeded
      }
    } while (again);
  }

  async function flush() {
    clearTimeout(timer); timer = null;
    if (running) { again = true; return running; }
    running = run().catch(e => { onError && onError(e); timer = setTimeout(flush, 5000); }).finally(() => { running = null; });
    return running;
  }

  return {
    prime(S) { snap = snapshotOf(toRows(S, uid)); },
    schedule() { clearTimeout(timer); timer = setTimeout(flush, 400); },
    flush
  };
}
