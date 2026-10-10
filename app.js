const DIFF_LABEL = { E: 'Easy', M: 'Medium', H: 'Hard' };
const STATUS_LABEL = ['To do', 'Review', 'Done'];
const GUEST_KEY = "dsa_tracker_state_v1";
const VIEW_KEY = "dsa_tracker_view_v1";
const $ = id => document.getElementById(id);

// ---------- State ----------
// state only ever holds problems the user touched: slug -> { status: 1|2, star: bool }.
// An untouched problem (todo, not starred) is simply absent — locally and in Firestore.
function lsGet(key, fallback) { try { return JSON.parse(localStorage.getItem(key) || fallback); } catch { return JSON.parse(fallback); } }
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage blocked */ } }
function loadGuest() {
  const out = {};
  for (const [slug, v] of Object.entries(lsGet(GUEST_KEY, '{}'))) {
    if (v && (v.status || v.star)) out[slug] = { status: v.status | 0, star: !!v.star };
  }
  return out;
}
function saveGuest() { lsSet(GUEST_KEY, state); }

let state = loadGuest();
let preferences = Object.assign({
  status: 'all', difficulty: 'all', starOnly: false, search: '',
  collapsedStages: {}, collapsedCategories: {},
}, lsGet(VIEW_KEY, '{}'));
function savePreferences() { lsSet(VIEW_KEY, preferences); }

let SECTIONS = [];
let cloud = null;         // cloud.js module (null if unavailable/offline-first-load)
let user = null;          // Firebase user
let profile = null;       // { username, ... } | null
let profileLoaded = false;
let unsubEntries = null;
let mergedGuest = false;
let serverSynced = false; // true once we've seen a non-cache snapshot

const LEETCODE_SCRIPT = `(async () => {
  try {
    if (!(location.hostname === "leetcode.com" || location.hostname.endsWith(".leetcode.com"))) {
      throw new Error("Open leetcode.com before running this.");
    }
    const query = \`query problemsetQuestionList($categorySlug:String,$limit:Int,$skip:Int,$filters:QuestionListFilterInput){
      userStatus{isSignedIn username}
      problemsetQuestionList:questionList(categorySlug:$categorySlug,limit:$limit,skip:$skip,filters:$filters){
        total:totalNum data{titleSlug status}}}\`;
    const pageSize = 100;
    let skip = 0, total = null;
    const solved = [];
    do {
      const res = await fetch("/graphql/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { categorySlug: "all-code-essentials", skip, limit: pageSize, filters: { status: "AC" } } })
      });
      if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
      const body = await res.json();
      if (body.errors?.length) throw new Error(body.errors[0].message || "GraphQL error.");
      const status = body.data?.userStatus;
      const page = body.data?.problemsetQuestionList;
      if (!status?.isSignedIn) throw new Error("Please sign in first.");
      if (!page || !Array.isArray(page.data) || typeof page.total !== "number") {
        throw new Error("LeetCode returned an invalid problem list.");
      }
      total = page.total;
      for (const task of page.data) {
        if (task.status?.toLowerCase() === "ac" && task.titleSlug) solved.push(task.titleSlug);
      }
      skip += page.data.length;
      if (page.data.length === 0 && skip < total) throw new Error("Stopped before all tasks were returned.");
    } while (skip < total);
    const solvedSlugs = [...new Set(solved)];
    const payload = { solved_slugs: solvedSlugs, exported_at: new Date().toISOString(), total_solved: solvedSlugs.length };
    const exported = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(exported);
      alert(\`Copied \${solvedSlugs.length} solved problems. Return to your tracker and choose "Paste solved list".\`);
    } catch (clipboardError) {
      console.warn("Could not copy solved problems; downloading a JSON file instead.", clipboardError);
      const blob = new Blob([exported], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "solved-progress.json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      alert(\`Clipboard access was unavailable, so \${solvedSlugs.length} solved problems were downloaded as JSON.\`);
    }
  } catch (err) {
    console.error(err);
    alert(err.message || "Export failed.");
  }
})();`;

const ICONS = {
  todo: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1d2021" stroke="#44494b" stroke-width="2"/></svg>`,
  review: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#1d2021" stroke="var(--review)" stroke-width="2"/><path d="M12 7.5V12l3 2" stroke="var(--review)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  done: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="var(--accent)"/><circle cx="12" cy="12" r="6.6" fill="none" stroke="#0a3b2b" stroke-width="1.9"/><path d="M9.1 12.2l2 2 3.8-4.2" stroke="#0a3b2b" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  ext: `<svg class="ext" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>`,
  starOff: `<svg viewBox="0 0 24 24" fill="none" stroke="var(--sub)" stroke-width="1.6"><path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3.1 1.4-6.3-4.8-4.3 6.4-.6z"/></svg>`,
  starOn: `<svg viewBox="0 0 24 24" fill="var(--gold)" stroke="var(--gold)" stroke-width="1.6"><path d="M12 3l2.6 5.9 6.4.6-4.8 4.3 1.4 6.3L12 17l-5.6 3.1 1.4-6.3-4.8-4.3 6.4-.6z"/></svg>`,
  chev: `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="var(--sub)" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`,
};
const STATUS_ICONS = [ICONS.todo, ICONS.review, ICONS.done];

const main = $('main');
const rows = new Map();      // slug -> { el, statusBtn, starBtn, title }
const catViews = [];         // { cat, el, stageTitle }
const stageViews = [];       // { stage, el, body, head }

function getRec(slug) { return state[slug] || { status: 0, star: false }; }
function allItems() { return SECTIONS.flatMap(s => s.cats.flatMap(c => c.items)); }

function notify(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove('visible'), 4200);
}
function copyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(textarea);
  textarea.select();
  let copied;
  try { copied = document.execCommand('copy'); } finally { textarea.remove(); }
  if (!copied) throw new Error('Clipboard access was denied by the browser.');
}
function syncError(err) { console.warn(err); notify('Could not sync to the cloud: ' + (cloud?.friendlyError(err) || err.message)); }

// ---------- Mutations ----------
/** changes: slug -> {status, star} | null. Applies locally, then persists (cloud if signed in, else localStorage). */
function applyChanges(changes) {
  const cloudChanges = {};
  for (const [slug, rec] of Object.entries(changes)) {
    if (!rec || (!rec.status && !rec.star)) { delete state[slug]; cloudChanges[slug] = null; }
    else { state[slug] = { status: rec.status, star: !!rec.star }; cloudChanges[slug] = state[slug]; }
  }
  if (user && cloud) cloud.saveMany(user.uid, cloudChanges).catch(syncError);
  else saveGuest();
  repaint(Object.keys(changes));
  scheduleBoard();
}

// ---------- Rendering ----------
function paintRow(slug) {
  const r = rows.get(slug);
  if (!r) return;
  const rec = getRec(slug);
  r.el.dataset.status = rec.status;
  r.el.dataset.star = rec.star ? '1' : '0';
  r.statusBtn.innerHTML = STATUS_ICONS[rec.status];
  r.statusBtn.setAttribute('aria-label', `${r.title}: ${STATUS_LABEL[rec.status]}. Tap to change status.`);
  r.starBtn.innerHTML = rec.star ? ICONS.starOn : ICONS.starOff;
  r.starBtn.setAttribute('aria-pressed', String(rec.star));
  r.starBtn.setAttribute('aria-label', `${rec.star ? 'Unstar' : 'Star'} ${r.title}`);
}

function repaint(slugs) {
  (slugs || [...rows.keys()]).forEach(paintRow);
  refreshStats();
}

function refreshStats() {
  const items = allItems();
  let done = 0, review = 0, star = 0;
  items.forEach(([slug]) => {
    const r = getRec(slug);
    if (r.status === 2) done++;
    if (r.status === 1) review++;
    if (r.star) star++;
  });
  $('statDone').textContent = done;
  $('statTotal').textContent = items.length;
  $('statReview').textContent = review;
  $('statStar').textContent = star;
  const pct = items.length ? done / items.length * 100 : 0;
  $('progressLabel').textContent = `${Math.round(pct)}%`;
  $('barDone').style.width = pct + '%';
  $('barReview').style.width = (items.length ? review / items.length * 100 : 0) + '%';
  $('bar').setAttribute('aria-valuenow', String(Math.round(pct)));
  catViews.forEach(({ cat, el }) => {
    el.querySelector('[data-count]').textContent = `${cat.items.filter(([s]) => getRec(s).status === 2).length}/${cat.items.length}`;
  });
  stageViews.forEach(({ stage, el }) => {
    const its = stage.cats.flatMap(c => c.items);
    el.querySelector('[data-stage-count]').textContent = `${its.filter(([s]) => getRec(s).status === 2).length}/${its.length}`;
  });
}

function buildRow(slug, title, diff) {
  const el = document.createElement('div');
  el.className = 'row';
  el.dataset.slug = slug;
  el.dataset.diff = diff;
  el.dataset.title = title.toLowerCase();

  const statusBtn = document.createElement('button');
  statusBtn.type = 'button';
  statusBtn.className = 'cell-btn status-btn';
  statusBtn.onclick = () => {
    const r = getRec(slug);
    applyChanges({ [slug]: { status: (r.status + 1) % 3, star: r.star } });
  };

  const link = document.createElement('a');
  link.className = 'prob-link';
  link.target = '_blank';
  link.rel = 'noopener';
  link.href = `https://leetcode.com/problems/${slug}/`;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = title;
  link.append(t);
  link.insertAdjacentHTML('beforeend', ICONS.ext);

  const d = document.createElement('span');
  d.className = `diff ${diff}`;
  d.textContent = DIFF_LABEL[diff];

  const starBtn = document.createElement('button');
  starBtn.type = 'button';
  starBtn.className = 'cell-btn star-btn';
  starBtn.onclick = () => {
    const r = getRec(slug);
    applyChanges({ [slug]: { status: r.status, star: !r.star } });
  };

  el.append(statusBtn, link, d, starBtn);
  rows.set(slug, { el, statusBtn, starBtn, title });
  paintRow(slug);
  return el;
}

function buildCategory(cat, stageTitle) {
  const key = `${stageTitle}::${cat.name}`;
  const el = document.createElement('section');
  el.className = 'cat';
  el.classList.toggle('collapsed', Boolean(preferences.collapsedCategories[key]));
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'cat-head';
  const h3 = document.createElement('h3');
  h3.textContent = cat.name;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.dataset.count = '';
  head.append(h3, meta);
  head.setAttribute('aria-expanded', String(!el.classList.contains('collapsed')));
  head.onclick = () => {
    el.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', String(!el.classList.contains('collapsed')));
    preferences.collapsedCategories[key] = el.classList.contains('collapsed');
    savePreferences();
  };
  const body = document.createElement('div');
  body.className = 'rows';
  cat.items.forEach(([slug, title, diff]) => body.appendChild(buildRow(slug, title, diff)));
  el.append(head, body);
  catViews.push({ cat, el, stageTitle });
  return el;
}

function render() {
  const frag = document.createDocumentFragment();
  SECTIONS.forEach(stage => {
    const wrap = document.createElement('div');
    wrap.className = 'stage';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'stage-head';
    const h2 = document.createElement('h2');
    h2.innerHTML = ICONS.chev;
    h2.append(stage.title);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.dataset.stageCount = '';
    head.append(h2, meta);
    const body = document.createElement('div');
    body.className = 'stage-body';
    const collapsed = Boolean(preferences.collapsedStages[stage.title]);
    body.classList.toggle('collapsed', collapsed);
    h2.querySelector('.chev').classList.toggle('collapsed-chev', collapsed);
    head.setAttribute('aria-expanded', String(!collapsed));
    stage.cats.forEach(cat => body.appendChild(buildCategory(cat, stage.title)));
    head.onclick = () => {
      body.classList.toggle('collapsed');
      const c = body.classList.contains('collapsed');
      h2.querySelector('.chev').classList.toggle('collapsed-chev', c);
      head.setAttribute('aria-expanded', String(!c));
      preferences.collapsedStages[stage.title] = c;
      savePreferences();
      updateCollapseButton();
    };
    wrap.append(head, body);
    frag.appendChild(wrap);
    stageViews.push({ stage, el: wrap, body, head });
  });
  main.appendChild(frag);
  refreshStats();
  bindFilters();
  updateCollapseButton();
}

// ---------- Filters ----------
let activeStatus = preferences.status, activeDiff = preferences.difficulty;
let starOnly = Boolean(preferences.starOnly), query = preferences.search;

function updateCollapseButton() {
  const collapsed = SECTIONS.length > 0 && SECTIONS.every(s => preferences.collapsedStages[s.title]);
  $('collapseAllBtn').lastElementChild.textContent = collapsed ? 'Expand all' : 'Collapse all';
}

function applyFilters() {
  main.classList.toggle('searching', Boolean(query));
  rows.forEach(({ el }) => {
    let show = true;
    if (activeStatus !== 'all' && el.dataset.status !== activeStatus) show = false;
    if (activeDiff !== 'all' && el.dataset.diff !== activeDiff) show = false;
    if (starOnly && el.dataset.star !== '1') show = false;
    if (query && !el.dataset.title.includes(query)) show = false;
    el.classList.toggle('hidden', !show);
  });
  catViews.forEach(({ el }) => { el.hidden = el.querySelector('.row:not(.hidden)') === null; });
  stageViews.forEach(({ el }) => { el.hidden = el.querySelector('.cat:not([hidden])') === null; });
  $('empty').hidden = !stageViews.every(({ el }) => el.hidden);
}

function bindFilters() {
  const search = $('search');
  const statusChips = [...document.querySelectorAll('.chip[data-status]')];
  const diffChips = [...document.querySelectorAll('.chip[data-diff]')];
  const sync = () => {
    statusChips.forEach(c => { const on = c.dataset.status === activeStatus; c.classList.toggle('active', on); c.setAttribute('aria-pressed', String(on)); });
    diffChips.forEach(c => { const on = c.dataset.diff === activeDiff; c.classList.toggle('active', on); c.setAttribute('aria-pressed', String(on)); });
    $('starOnly').classList.toggle('active', starOnly);
    $('starOnly').setAttribute('aria-pressed', String(starOnly));
  };
  search.value = query;
  search.addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); preferences.search = query; savePreferences(); applyFilters(); });
  statusChips.forEach(c => c.addEventListener('click', () => { activeStatus = c.dataset.status; preferences.status = activeStatus; savePreferences(); sync(); applyFilters(); }));
  diffChips.forEach(c => c.addEventListener('click', () => { activeDiff = activeDiff === c.dataset.diff ? 'all' : c.dataset.diff; preferences.difficulty = activeDiff; savePreferences(); sync(); applyFilters(); }));
  $('starOnly').addEventListener('click', () => { starOnly = !starOnly; preferences.starOnly = starOnly; savePreferences(); sync(); applyFilters(); });
  sync();
  applyFilters();
}

// ---------- Dialogs ----------
function openDlg(dlg) { if (!dlg.open) dlg.showModal(); }
document.querySelectorAll('dialog.sheet').forEach(dlg => {
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  dlg.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dlg.close()));
});
$('menuBtn').onclick = () => openDlg($('menuDlg'));
function menuAction(id, fn) { $(id).addEventListener('click', () => { $('menuDlg').close(); fn(); }); }

// ---------- Import / export / reset ----------
function importSolvedSlugs(slugs, source) {
  if (!Array.isArray(slugs)) throw new Error('No solved_slugs array found.');
  const known = new Set(allItems().map(([slug]) => slug));
  const changes = {};
  slugs.forEach(slug => {
    if (known.has(slug) && getRec(slug).status !== 2) changes[slug] = { status: 2, star: getRec(slug).star };
  });
  const n = Object.keys(changes).length;
  if (n) applyChanges(changes);
  notify(`Marked ${n} problem${n === 1 ? '' : 's'} as Done from ${source}.`);
}
function importProgressMap(map, source) {
  const known = new Set(allItems().map(([slug]) => slug));
  const changes = {};
  for (const [slug, v] of Object.entries(map)) {
    if (known.has(slug) && v && [0, 1, 2].includes(v.status)) changes[slug] = { status: v.status, star: !!v.star };
  }
  const n = Object.keys(changes).length;
  if (n) applyChanges(changes);
  notify(`Imported ${n} problem${n === 1 ? '' : 's'} from ${source}.`);
}
function importData(data, source) {
  if (data && Array.isArray(data.solved_slugs)) importSolvedSlugs(data.solved_slugs, source);
  else if (data && typeof data === 'object') importProgressMap(data, source);
  else throw new Error('Unrecognised file format.');
}

menuAction('importBtn', () => $('importFile').click());
$('importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try { importData(JSON.parse(reader.result), 'the imported file'); }
    catch (err) { notify('Could not read that file: ' + err.message); }
  };
  reader.readAsText(file);
  e.target.value = '';
});
menuAction('pasteSolvedBtn', async () => {
  try { importData(JSON.parse(await navigator.clipboard.readText()), 'the clipboard'); }
  catch (err) { notify('Could not read solved problems from the clipboard: ' + err.message + ' Use “Import file” if clipboard access is blocked.'); }
});
menuAction('exportBtn', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'dsa-tracker-progress.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
menuAction('resetBtn', () => {
  if (user && cloud) {
    if (!confirm('Clear ALL your saved progress, including the cloud copy? This cannot be undone.')) return;
    const wipe = Object.fromEntries(Object.keys(state).map(s => [s, null]));
    state = {};
    cloud.saveMany(user.uid, wipe).catch(syncError);
  } else {
    if (!confirm('Clear all local progress? This cannot be undone.')) return;
    state = {};
    saveGuest();
  }
  repaint();
  scheduleBoard();
});
menuAction('collapseAllBtn', () => {
  const collapse = !SECTIONS.every(s => preferences.collapsedStages[s.title]);
  SECTIONS.forEach(s => { preferences.collapsedStages[s.title] = collapse; });
  stageViews.forEach(({ body, head }) => {
    body.classList.toggle('collapsed', collapse);
    head.querySelector('.chev').classList.toggle('collapsed-chev', collapse);
    head.setAttribute('aria-expanded', String(!collapse));
  });
  savePreferences();
  updateCollapseButton();
});
menuAction('syncBtn', async () => {
  try {
    try { await navigator.clipboard.writeText(LEETCODE_SCRIPT); } catch { copyText(LEETCODE_SCRIPT); }
    notify('Sync script copied. Paste it into the console on leetcode.com, then use “Paste solved list” here.');
  } catch (err) { notify('Could not copy the sync script: ' + err.message); }
});

// ---------- Leaderboard sync ----------
let boardTimer = null, lastBoardKey = '';
function counts() {
  let solved = 0, review = 0, starred = 0;
  allItems().forEach(([slug]) => { const r = getRec(slug); if (r.status === 2) solved++; if (r.status === 1) review++; if (r.star) starred++; });
  return { solved, review, starred };
}
function scheduleBoard() {
  if (!user || !profile?.username || !serverSynced) return;
  clearTimeout(boardTimer);
  boardTimer = setTimeout(pushBoard, 2500);
}
function pushBoard() {
  if (!user || !cloud || !profile?.username || !serverSynced || !SECTIONS.length) return;
  const c = counts();
  const key = `${c.solved}/${c.review}/${c.starred}`;
  if (key === lastBoardKey) return;
  lastBoardKey = key;
  cloud.pushLeaderboard(user.uid, profile.username, c).catch(err => { lastBoardKey = ''; console.warn('Leaderboard update failed', err); });
}
document.addEventListener('visibilitychange', () => { if (document.hidden && boardTimer) { clearTimeout(boardTimer); pushBoard(); } });

async function openLeaderboard() {
  if (!cloud?.enabled) { notify('The leaderboard needs cloud sync, which isn’t configured here.'); return; }
  const list = $('boardList'), msg = $('boardMsg');
  list.replaceChildren();
  msg.hidden = false; msg.textContent = 'Loading…';
  openDlg($('boardDlg'));
  try {
    const users = await cloud.topUsers(50);
    msg.hidden = users.length > 0;
    msg.textContent = 'Nobody is on the board yet. Pick a username and start solving!';
    users.forEach((u, i) => {
      const li = document.createElement('li');
      if (user && u.uid === user.uid) li.className = 'me';
      const rank = document.createElement('span'); rank.className = 'rank'; rank.textContent = i + 1;
      const who = document.createElement('span'); who.className = 'who'; who.textContent = '@' + u.username;
      const score = document.createElement('span'); score.className = 'score'; score.textContent = `${u.solved} solved`;
      li.append(rank, who, score);
      list.appendChild(li);
    });
  } catch (err) {
    msg.hidden = false;
    msg.textContent = 'Could not load the leaderboard: ' + cloud.friendlyError(err);
  }
}
menuAction('leaderboardBtn', openLeaderboard);

// ---------- Account UI ----------
function fillAvatar(el) {
  el.replaceChildren();
  const label = profile?.username || user?.displayName || user?.email || '?';
  if (user?.photoURL && user.photoURL.startsWith('https://')) {
    const img = document.createElement('img');
    img.src = user.photoURL; img.alt = ''; img.referrerPolicy = 'no-referrer';
    img.width = img.height = 56; img.style.cssText = 'width:100%;height:100%;object-fit:cover';
    img.onerror = () => { el.replaceChildren(label[0].toUpperCase()); };
    el.appendChild(img);
  } else {
    el.textContent = label[0].toUpperCase();
  }
}
function renderAccountBtn() {
  const btn = $('accountBtn');
  btn.replaceChildren();
  if (!user) { btn.className = 'account-btn'; btn.textContent = 'Sign in'; return; }
  btn.className = 'account-btn signed';
  const av = document.createElement('span'); av.className = 'avatar';
  fillAvatar(av);
  const name = document.createElement('span');
  name.textContent = profile?.username ? '@' + profile.username : (user.displayName || user.email || 'Account').split(' ')[0];
  name.style.cssText = 'overflow:hidden;text-overflow:ellipsis';
  btn.append(av, name);
}
function openAccount() {
  fillAvatar($('accAvatar'));
  $('accName').textContent = profile?.username ? '@' + profile.username : (user.displayName || 'Signed in');
  $('accEmail').textContent = user.email || '';
  $('accSetName').hidden = Boolean(profile?.username);
  openDlg($('accountDlg'));
}
$('accountBtn').onclick = () => {
  if (user) openAccount();
  else { resetAuthForm(); openDlg($('authDlg')); }
};
$('accLeaderboard').onclick = () => { $('accountDlg').close(); openLeaderboard(); };
$('accSetName').onclick = () => { $('accountDlg').close(); openNameDialog(); };
$('signOutBtn').onclick = async () => {
  $('accountDlg').close();
  try { await cloud.logout(); notify('Signed out.'); } catch (err) { notify(cloud.friendlyError(err)); }
};

// ---------- Auth form ----------
let authMode = 'signin';
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  $('authTitle').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
  $('authSubmit').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
  $('authPass').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  $('forgotBtn').hidden = mode !== 'signin';
  setAuthError('');
}
function setAuthError(msg) { const e = $('authError'); e.textContent = msg; e.hidden = !msg; }
function resetAuthForm() {
  const on = Boolean(cloud?.enabled);
  $('authOff').hidden = on;
  $('authBody').hidden = !on;
  if (!on) $('authOff').textContent = cloud
    ? 'Cloud sync isn’t configured for this deployment yet, so progress is saved in this browser only.'
    : 'Cloud sync couldn’t be loaded (are you offline?). Progress is saved in this browser only.';
  $('authPass').value = '';
  setAuthMode('signin');
}
document.querySelectorAll('.seg-btn').forEach(b => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));

async function runAuth(btn, fn) {
  setAuthError('');
  btn.disabled = true;
  try { await fn(); $('authDlg').close(); }
  catch (err) { setAuthError(cloud.friendlyError(err)); }
  finally { btn.disabled = false; }
}
$('googleBtn').onclick = () => runAuth($('googleBtn'), () => cloud.signInGoogle());
$('authForm').addEventListener('submit', e => {
  e.preventDefault();
  const email = $('authEmail').value.trim(), pw = $('authPass').value;
  if (!email || !pw) { setAuthError('Enter your email and password.'); return; }
  runAuth($('authSubmit'), () => authMode === 'signup' ? cloud.signUpEmail(email, pw) : cloud.signInEmail(email, pw));
});
$('forgotBtn').onclick = async () => {
  const email = $('authEmail').value.trim();
  if (!email) { setAuthError('Type your email above first, then tap “Forgot password?”.'); return; }
  try { await cloud.resetPassword(email); setAuthError(''); notify('If that email has an account, a reset link is on its way.'); }
  catch (err) { setAuthError(cloud.friendlyError(err)); }
};

// ---------- Username ----------
function openNameDialog() {
  $('nameError').hidden = true;
  $('nameInput').value = '';
  openDlg($('nameDlg'));
}
$('nameForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('nameError'), btn = $('nameSubmit');
  const name = $('nameInput').value.trim().toLowerCase();
  err.hidden = true;
  btn.disabled = true;
  try {
    await cloud.claimUsername(user, name);
    profile = { username: name };
    renderAccountBtn();
    $('nameDlg').close();
    notify(`You're @${name}.`);
    scheduleBoard();
  } catch (ex) {
    err.textContent = ex.message || cloud.friendlyError(ex);
    err.hidden = false;
  } finally { btn.disabled = false; }
});

// ---------- Cloud wiring ----------
function onEntries(snap) {
  snap.docChanges().forEach(ch => {
    if (ch.type === 'removed') delete state[ch.doc.id];
    else {
      const d = ch.doc.data();
      if (d.status || d.star) state[ch.doc.id] = { status: d.status | 0, star: !!d.star };
      else delete state[ch.doc.id];
    }
  });
  repaint();
  if (!snap.metadata.fromCache) {
    serverSynced = true;
    if (!mergedGuest) { mergedGuest = true; mergeGuest(); }
    scheduleBoard();
  }
}

/** First sign-in: upload anything tracked as a guest that the cloud doesn't already have. */
function mergeGuest() {
  const guest = loadGuest();
  const known = new Set(allItems().map(([s]) => s));
  const add = {};
  for (const [slug, rec] of Object.entries(guest)) if (!state[slug] && known.has(slug)) add[slug] = rec;
  const n = Object.keys(add).length;
  if (!Object.keys(guest).length) return;
  if (!n) { try { localStorage.removeItem(GUEST_KEY); } catch {} return; }
  Object.entries(add).forEach(([s, r]) => { state[s] = r; });
  repaint();
  cloud.saveMany(user.uid, add)
    .then(() => { try { localStorage.removeItem(GUEST_KEY); } catch {} notify(`Uploaded ${n} problem${n === 1 ? '' : 's'} from this browser to your account.`); })
    .catch(syncError);
}

let askedName = false;
async function onUserChange(u) {
  unsubEntries?.(); unsubEntries = null;
  clearTimeout(boardTimer);
  user = u; profile = null; profileLoaded = false; mergedGuest = false; serverSynced = false; lastBoardKey = '';
  renderAccountBtn();
  if (!u) { state = loadGuest(); repaint(); return; }
  state = {};
  repaint();
  unsubEntries = cloud.watchEntries(u.uid, onEntries, err => syncError(err));
  try {
    const p = await cloud.loadProfile(u.uid);
    if (user !== u) return;
    profile = p; profileLoaded = true;
  } catch (err) { console.warn('Could not load profile (offline?)', err); }
  renderAccountBtn();
  scheduleBoard();
  if (profileLoaded && !profile && !askedName) { askedName = true; openNameDialog(); }
}

// ---------- PWA install ----------
let installPrompt = null;
const installBtn = $('installBtn');
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; installBtn.hidden = false; });
installBtn.addEventListener('click', async () => {
  $('menuDlg').close();
  if (!installPrompt) return;
  await installPrompt.prompt();
  const result = await installPrompt.userChoice;
  installPrompt = null; installBtn.hidden = true;
  if (result.outcome === 'accepted') notify('DSA Tracker is installed.');
});
window.addEventListener('appinstalled', () => { installPrompt = null; installBtn.hidden = true; notify('DSA Tracker is installed.'); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./service-worker.js').catch(error => console.error('Service worker registration failed:', error));
}

// ---------- Boot ----------
fetch('problems.json')
  .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
  .then(data => { SECTIONS = data.sections; render(); })
  .catch(err => {
    main.textContent = '';
    const p = document.createElement('p');
    p.style.color = '#f0543a';
    p.textContent = 'Could not load problems.json: ' + err.message;
    main.appendChild(p);
  });

// Cloud is optional: if the Firebase SDK can't load (offline first visit, blocked), the app still works locally.
(async () => {
  try {
    cloud = await import('./cloud.js');
    if (cloud.enabled) cloud.onUser(onUserChange);
  } catch (err) {
    console.warn('Cloud sync unavailable:', err);
  }
})();
