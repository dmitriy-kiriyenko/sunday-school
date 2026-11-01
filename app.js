'use strict';

// Lesson files live in lessons/<id>.json; lessons/index.json lists the ids.
// Progress is stored per lesson in localStorage, so a reload keeps your place.

const app = document.getElementById('app');
const CHECKABLE = new Set(['do', 'ask', 'say', 'read', 'hint']);
const LABELS = { ask: 'Спросить', say: 'Сказать', read: 'Прочитать' };
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
  'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const settings = load('ss:settings', { font: 18, wake: true });
let lesson = null;   // { id, ...json, slides with computed fields }
let state = null;    // { pos, done: {slideId: true}, checks: {"slideId/itemIdx": true} }
let wakeLock = null;

// ---------- storage ----------
function load(key, fallback) {
  try { return Object.assign(fallback, JSON.parse(localStorage.getItem(key)) || {}); }
  catch { return fallback; }
}
function save() {
  if (lesson) localStorage.setItem('ss:lesson:' + lesson.id, JSON.stringify(state));
  localStorage.setItem('ss:settings', JSON.stringify(settings));
}

// ---------- data ----------
async function fetchJson(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(path + ': ' + res.status);
  return res.json();
}

// Gives every slide an id and, for timed slides, its planned start minute.
function prepare(id, data) {
  let t = 0;
  data.slides.forEach((s, i) => {
    s.id = s.id || String(i);
    s.index = i;
    if (s.minutes) { s.start = t; t += s.minutes; }
  });
  data.total = t;
  data.id = id;
  return data;
}

function isDone(s) {
  if (state.done[s.id]) return true;
  const checkable = s.items.map((it, i) => [it, i]).filter(([it]) => CHECKABLE.has(it.t));
  return checkable.length > 0 && checkable.every(([, i]) => state.checks[s.id + '/' + i]);
}

function remainingPercent(l, st) {
  const prev = state; state = st;
  const doneMin = l.slides.filter(s => s.minutes && isDone(s)).reduce((a, s) => a + s.minutes, 0);
  state = prev;
  return Math.round(100 * (l.total - doneMin) / l.total);
}

// ---------- formatting ----------
function esc(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function md(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(.+?)\*/g, '<i>$1</i>')
    .replace(/\n/g, '<br>');
}
function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// ---------- home ----------
async function showHome() {
  lesson = null;
  releaseWake();
  document.title = 'Воскресная школа';
  app.innerHTML = '<header class="home-head"><h1>Уроки</h1></header><main class="list">Загрузка…</main>';
  try {
    const ids = await fetchJson('lessons/index.json');
    const lessons = await Promise.all(ids.map(async id => prepare(id, await fetchJson(`lessons/${id}.json`))));
    lessons.sort((a, b) => b.date.localeCompare(a.date));
    app.querySelector('.list').innerHTML = lessons.map(l => {
      const st = load('ss:lesson:' + l.id, { pos: 0, done: {}, checks: {} });
      const left = remainingPercent(l, st);
      const status = left === 100 ? `${l.total} мин по плану` : left === 0 ? '✓ пройден' : `осталось ${left}%`;
      return `<a class="card" href="#/${l.id}">
        <div class="card-date">${fmtDate(l.date)}</div>
        <div class="card-title">${md(l.title)}</div>
        <div class="card-sub">${md(l.subtitle || '')}</div>
        <div class="card-meta">${esc(l.scripture || '')}<span>${status}</span></div>
      </a>`;
    }).join('');
  } catch (e) {
    app.querySelector('.list').textContent = 'Не удалось загрузить уроки: ' + e.message;
  }
}

// ---------- lesson ----------
async function showLesson(id) {
  if (!lesson || lesson.id !== id) {
    app.innerHTML = '<main class="list">Загрузка…</main>';
    try { lesson = prepare(id, await fetchJson(`lessons/${id}.json`)); }
    catch (e) { app.innerHTML = `<main class="list">Урок не найден. <a href="#/">К списку</a></main>`; return; }
    state = load('ss:lesson:' + id, { pos: 0, done: {}, checks: {} });
    state.pos = Math.min(state.pos, lesson.slides.length);
  }
  document.title = lesson.title;
  if (settings.wake) requestWake();
  render();
}

function render(direction) {
  const finished = state.pos >= lesson.slides.length;
  const s = finished ? null : lesson.slides[state.pos];
  const left = remainingPercent(lesson, state);
  const timed = lesson.slides.filter(x => x.minutes);

  const bar = timed.map(x => {
    const cls = [isDone(x) ? 'done' : '', s && x.id === s.id ? 'cur' : ''].join(' ');
    return `<button class="seg ${cls}" style="flex-grow:${x.minutes}" data-go="${x.index}" aria-label="${esc(x.title)}"></button>`;
  }).join('');

  let where;
  if (finished) where = 'Урок завершён';
  else if (s.kind === 'prep') where = 'До урока';
  else if (s.kind === 'backup') where = 'Запасной · ' + esc(s.note || '');
  else where = `Блок ${timed.indexOf(s) + 1}/${timed.length} · мин ${s.start}–${s.start + s.minutes}`;

  app.innerHTML = `
    <header class="top">
      <div class="top-row">
        <a class="icon-btn" href="#/" aria-label="К списку">‹</a>
        <div class="left"><b>${left}%</b> осталось</div>
        <button class="icon-btn" data-act="tips" aria-label="Шпаргалки">📌</button>
        <button class="icon-btn" data-act="menu" aria-label="Меню">⋯</button>
      </div>
      <div class="bar">${bar}</div>
    </header>
    <main class="slide ${direction ? 'in-' + direction : ''} ${s ? 'kind-' + (s.kind || 'block') : ''}">
      ${finished ? finishedHtml() : slideHtml(s, where)}
    </main>
    <footer class="nav">
      <button class="prev" data-act="prev" ${state.pos === 0 ? 'disabled' : ''}>←</button>
      ${finished
        ? '<a class="next" href="#/">К списку уроков</a>'
        : `<button class="next" data-act="next">${nextLabel(s)}</button>`}
    </footer>`;
  document.documentElement.style.setProperty('--font', settings.font + 'px');
  window.scrollTo(0, 0);
}

function nextLabel(s) {
  if (s.index === lesson.slides.length - 1) return 'Готово ✓ Закончить';
  const next = lesson.slides[s.index + 1];
  return `Готово ✓ <span>→ ${esc(next.title)}</span>`;
}

function slideHtml(s, where) {
  const items = s.items.map((it, i) => {
    const key = s.id + '/' + i;
    const checkable = CHECKABLE.has(it.t);
    const checked = !!state.checks[key];
    const label = it.label || LABELS[it.t] || '';
    if (it.t === 'hint') {
      return `<button class="item hint ${checked ? 'checked' : ''}" data-check="${key}">
        <span class="box"></span><span class="ref">${esc(it.ref)}</span><span class="txt">${md(it.text)}</span></button>`;
    }
    if (!checkable) return `<div class="item ${it.t}">${md(it.text)}</div>`;
    return `<button class="item ${it.t} ${checked ? 'checked' : ''}" data-check="${key}">
      <span class="box"></span>
      <span class="body">${label ? `<span class="tag">${esc(label)}</span>` : ''}<span class="txt">${md(it.text)}</span></span>
    </button>`;
  }).join('');
  const choices = (s.choices || []).map(c => {
    const target = lesson.slides.find(x => x.id === c.goto);
    return `<button class="choice" data-jump="${target.index}">${esc(c.label)}</button>`;
  }).join('');
  return `
    <div class="where">${where}</div>
    <h2>${md(s.title)}
      <button class="done-chip ${isDone(s) ? 'on' : ''}" data-act="toggle-done">${isDone(s) ? '✓ сделано' : 'не сделано'}</button>
    </h2>
    <div class="items">${items}</div>
    ${choices ? `<div class="choices">${choices}</div>` : ''}`;
}

function finishedHtml() {
  const skipped = lesson.slides.filter(s => s.minutes && !isDone(s));
  return `<div class="where">${fmtDate(lesson.date)}</div>
    <h2>Урок завершён 🙏</h2>
    ${skipped.length
      ? `<div class="item note">Не отмечены: ${skipped.map(s => esc(s.title)).join(', ')}</div>`
      : '<div class="item note">Все блоки плана отмечены.</div>'}`;
}

function go(pos, markCurrent) {
  const cur = lesson.slides[state.pos];
  if (markCurrent && cur) state.done[cur.id] = true;
  const dir = pos > state.pos ? 'next' : pos < state.pos ? 'prev' : '';
  state.pos = Math.max(0, Math.min(pos, lesson.slides.length));
  save();
  render(dir);
}

// ---------- overlays ----------
function overlay(html) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `<div class="sheet">${html}<button class="close" data-act="close">Закрыть</button></div>`;
  el.addEventListener('click', e => {
    if (e.target === el || e.target.closest('[data-act="close"]')) el.remove();
  });
  document.body.appendChild(el);
  return el;
}

function showTips() {
  overlay('<h3>📌 Шпаргалки</h3>' + (lesson.tips || []).map(t =>
    `<div class="tip"><b>${esc(t.title)}.</b> ${md(t.text)}</div>`).join(''));
}

function showMenu() {
  const el = overlay(`
    <h3>${md(lesson.title)}</h3>
    <div class="menu-row">Шрифт
      <span><button data-m="font-">A−</button><button data-m="font+">A+</button></span></div>
    <label class="menu-row">Не гасить экран
      <input type="checkbox" data-m="wake" ${settings.wake ? 'checked' : ''}></label>
    <div class="menu-list">${lesson.slides.map(s =>
      `<button data-m="go" data-pos="${s.index}" class="${isDone(s) ? 'done' : ''} ${s.index === state.pos ? 'cur' : ''}">
        <span>${isDone(s) ? '✓' : ''}</span>${esc(s.title)}<small>${s.minutes ? s.start + '′' : s.kind === 'prep' ? 'до' : 'зап.'}</small></button>`).join('')}</div>
    <button class="danger" data-m="reset">Сбросить отметки этого урока</button>`);
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const m = b.dataset.m;
    if (m === 'font+' || m === 'font-') {
      settings.font = Math.max(14, Math.min(30, settings.font + (m === 'font+' ? 2 : -2)));
      document.documentElement.style.setProperty('--font', settings.font + 'px');
      save();
    } else if (m === 'go') {
      el.remove(); go(Number(b.dataset.pos));
    } else if (m === 'reset' && confirm('Сбросить все галочки этого урока?')) {
      state = { pos: 0, done: {}, checks: {} };
      el.remove(); save(); render();
    }
  });
  el.addEventListener('change', e => {
    if (e.target.dataset.m === 'wake') {
      settings.wake = e.target.checked; save();
      settings.wake ? requestWake() : releaseWake();
    }
  });
}

// ---------- screen wake lock ----------
async function requestWake() {
  try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); }
  catch { /* not supported or not allowed; ignore */ }
}
function releaseWake() { wakeLock?.release(); wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && lesson && settings.wake) requestWake();
});

// ---------- events ----------
app.addEventListener('click', e => {
  if (!lesson) return;
  const t = e.target.closest('[data-act],[data-check],[data-go],[data-jump]');
  if (!t) return;
  if (settings.wake) requestWake(); // some browsers require a user gesture
  if (t.dataset.check) {
    const k = t.dataset.check;
    if (state.checks[k]) delete state.checks[k]; else state.checks[k] = true;
    save(); render();
  } else if (t.dataset.go) go(Number(t.dataset.go));
  else if (t.dataset.jump) go(Number(t.dataset.jump), true);
  else switch (t.dataset.act) {
    case 'next': go(state.pos + 1, true); break;
    case 'prev': go(state.pos - 1); break;
    case 'tips': showTips(); break;
    case 'menu': showMenu(); break;
    case 'toggle-done': {
      const s = lesson.slides[state.pos];
      if (isDone(s)) {
        delete state.done[s.id];
        s.items.forEach((_, i) => delete state.checks[s.id + '/' + i]);
      } else state.done[s.id] = true;
      save(); render();
    }
  }
});

// Horizontal swipe = the same as the ← / «Готово» buttons.
let touch = null;
app.addEventListener('touchstart', e => {
  if (e.touches.length === 1) touch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: true });
app.addEventListener('touchend', e => {
  if (!touch || !lesson || document.querySelector('.overlay')) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) < 70 || Math.abs(dx) < 2 * Math.abs(dy)) return;
  if (dx < 0 && state.pos < lesson.slides.length) go(state.pos + 1, true);
  if (dx > 0 && state.pos > 0) go(state.pos - 1);
});

function route() {
  const id = location.hash.replace(/^#\/?/, '');
  id ? showLesson(id) : showHome();
}
window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
