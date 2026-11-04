import {
  parseKeymap, serializeKeymap, bindingToString, parseBindingString, templateKeymap, expandDefines,
} from './dts.js';
import { ZONKEY_LAYOUT, ROW_SIZES, TRACKBALL, PC_KEYMAP, pcKeyLabel, positionName, layoutBounds } from './layout.js';
import {
  KEYS, CATEGORIES, parseKeyExpr, keyLabel, charTable, keyByCode, MOD_FUNCS, MOD_USAGE_BIT, isShiftedAlias,
} from './keycodes.js';
import { describeBinding, flavorJa } from './describe.js';
import { Simulator, guessMouseLayer } from './sim.js';
import { lintKeymap } from './lint.js';
import * as GH from './github.js';

const KEY_COUNT = ZONKEY_LAYOUT.length;
const STORE_KEY = 'zonkey-kobo:v1';
const GH_KEY = 'zonkey-kobo:github';
const TOKEN_KEY = 'zonkey-kobo:token';

// ---------------------------------------------------------------- 小道具

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できない環境 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
const cloneB = (b) => ({ behavior: b.behavior, params: [...b.params] });
const TRANS = () => ({ behavior: 'trans', params: [] });

// ---------------------------------------------------------------- 状態

const state = {
  baseText: '',
  origin: { type: 'none', name: '' },
  parsed: null,
  layers: [], // { origIndex, displayName, bindings, sensorBindings }
  current: 0,
  selected: null,
  mode: 'edit',
  host: 'jis',
  history: [],
  future: [],
  clipboard: null,
  mouseLayer: null,
  sim: { pcKeys: true, latch: false, viewLayer: null },
  test: { on: false, tested: {}, last: null },
};

function layerNames() {
  return state.layers.map((l, i) => l.displayName || state.parsed?.layers?.[l.origIndex]?.nodeName || `layer_${i}`);
}
function ctx() { return { parsed: state.parsed, host: state.host, layerNames: layerNames() }; }

function snapshotLayers() {
  return state.layers.map((l) => ({ ...l, bindings: l.bindings.map(cloneB) }));
}

function commit(mutator, { keepFuture = false } = {}) {
  state.history.push(snapshotLayers());
  if (state.history.length > 200) state.history.shift();
  if (!keepFuture) state.future = [];
  mutator();
  changed();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(snapshotLayers());
  state.layers = state.history.pop();
  state.current = Math.min(state.current, state.layers.length - 1);
  changed();
  toast('元に戻しました');
}
function redo() {
  if (!state.future.length) return;
  state.history.push(snapshotLayers());
  state.layers = state.future.pop();
  changed();
  toast('やり直しました');
}

let persistTimer;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    store.set(STORE_KEY, {
      baseText: state.baseText,
      workText: state.parsed?.text,
      origin: state.origin,
      host: state.host,
      current: state.current,
      layers: state.layers.map(({ origIndex, displayName, bindings, sensorBindings }) => ({ origIndex, displayName, bindings, sensorBindings })),
    });
  }, 300);
}

function output() { return serializeKeymap(state.parsed, state.layers, ROW_SIZES); }
function isDirty() { return state.parsed && output() !== state.baseText; }

/** 新しいキーマップテキストを基準として読み込む */
function setBase(text, origin, { keepView = false } = {}) {
  const parsed = parseKeymap(text);
  if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
  state.baseText = text;
  state.parsed = parsed;
  state.origin = origin;
  state.layers = parsed.layers.map((l, i) => ({
    origIndex: i, displayName: l.displayName, bindings: l.bindings.map(cloneB), sensorBindings: l.sensorBindings,
  }));
  state.history = []; state.future = [];
  if (!keepView) { state.current = 0; state.selected = null; }
  state.current = Math.min(state.current, state.layers.length - 1);
  state.mouseLayer = guessMouseLayer(parsed, parsed.layers.length);
  state.test.tested = {};
  sim.parsed = parsed;
  sim.mouseLayer = state.mouseLayer;
  sim.setLayers(state.layers.map((l) => l.bindings), parsed);
  sim.reset();
  changed();
}

// ---------------------------------------------------------------- シミュレーター

let simChangeQueued = false;
const sim = new Simulator({ parsed: null, layers: [], host: 'jis', onChange: () => onSimChange() });

function onSimChange() {
  if (simChangeQueued) return;
  simChangeQueued = true;
  requestAnimationFrame(() => {
    simChangeQueued = false;
    if (state.mode === 'sim') { renderBoard(); renderLayerTabs(); updateSimPanel(); }
  });
}

// ---------------------------------------------------------------- 描画: 共通

function changed() {
  sim.setLayers(state.layers.map((l) => l.bindings));
  renderSource();
  renderLayerTabs();
  renderBoard();
  renderPanel();
  renderLintBadge();
  $('btnUndo').disabled = !state.history.length;
  $('btnRedo').disabled = !state.future.length;
  persist();
}

function renderSource() {
  const o = state.origin;
  const name = {
    github: `GitHub: ${o.owner}/${o.repo} (${o.branch}) ${o.path}`,
    official: '公式デフォルト（kureyakey/zmk-config-zonkey）',
    file: `ファイル: ${o.name}`,
    paste: '貼り付けたキーマップ',
    template: '新規（ひな形）',
  }[o.type] || '未読み込み';
  const el = $('sourceInfo');
  el.textContent = name;
  if (isDirty()) el.append(' ', h('span', { class: 'dirty' }, '● 未保存の変更あり'));
}

function renderLintBadge() {
  const list = runLint();
  const errs = list.filter((x) => x.level === 'error').length;
  const warns = list.filter((x) => x.level === 'warn').length;
  const b = $('lintBadge');
  b.className = 'badge' + (errs ? ' err' : warns ? ' warn' : '');
  b.textContent = errs ? `エラー${errs}` : warns ? `注意${warns}` : '';
}

function runLint() {
  if (!state.parsed) return [];
  return lintKeymap({
    parsed: state.parsed, layers: state.layers, keyCount: KEY_COUNT, host: state.host,
    mouseLayer: state.mouseLayer, layerNames: layerNames(), positionName,
  });
}

function viewLayer() {
  if (state.mode === 'sim') return state.sim.viewLayer ?? sim.topLayer() ?? 0;
  return state.current;
}

function renderLayerTabs() {
  const box = $('layerTabs');
  box.replaceChildren();
  const names = layerNames();
  const active = state.mode === 'sim' ? new Set(sim.activeLayers()) : new Set();
  const view = viewLayer();
  state.layers.forEach((l, i) => {
    const isMouse = i === state.mouseLayer;
    const btn = h('button', {
      class: (i === view ? 'active ' : '') + (active.has(i) ? 'on' : ''),
      title: state.mode === 'sim' ? (active.has(i) ? '有効なレイヤー' : '') : 'クリックで表示 / ダブルクリックで名前を変更',
      onclick: () => {
        if (state.mode === 'sim') { state.sim.viewLayer = state.sim.viewLayer === i ? null : i; renderBoard(); renderLayerTabs(); updateSimPanel(); return; }
        state.current = i; state.selected = state.selected; renderLayerTabs(); renderBoard(); renderPanel(); persist();
      },
      ondblclick: () => { if (state.mode === 'edit') renameLayer(i); },
    }, h('span', { class: 'num' }, i), names[i], isMouse ? ' 🖱' : '');
    box.append(btn);
  });
  if (state.mode === 'edit') {
    box.append(h('button', { class: 'small', title: 'レイヤーを追加', onclick: addLayer }, '＋ レイヤー追加'));
  }
  if (state.mode === 'sim') {
    box.append(h('span', { class: 'muted', style: { fontSize: '12px' } },
      state.sim.viewLayer != null ? `レイヤー${state.sim.viewLayer} を表示中（もう一度押すと自動に戻る）` : '表示は押しているレイヤーに自動で切り替わります'));
  }
}

// ---------------------------------------------------------------- 描画: キーボード

let unit = 56;
function computeUnit() {
  const wrap = document.querySelector('.board-wrap');
  const b = layoutBounds();
  const w = wrap.clientWidth || 800;
  unit = Math.max(20, Math.min(66, Math.floor(w / b.w)));
  document.documentElement.style.setProperty('--u', unit + 'px');
}

function effectiveBinding(layerIdx, pos) {
  for (let l = layerIdx; l >= 0; l--) {
    const b = state.layers[l]?.bindings[pos];
    if (b && b.behavior !== 'trans') return { binding: b, layer: l };
  }
  return { binding: { behavior: 'none', params: [] }, layer: 0 };
}

function renderBoard() {
  const board = $('board');
  if (!state.parsed) { board.replaceChildren(h('div', { class: 'empty' }, 'キーマップを読み込んでください')); return; }
  computeUnit();
  const b = layoutBounds();
  const u = unit;
  const offY = b.minY;
  board.style.width = b.w * u + 'px';
  board.style.height = (b.h - offY) * u + 'px';
  board.replaceChildren();
  const view = viewLayer();
  const c = ctx();
  const lintPos = new Set(runLintCached().filter((x) => x.level === 'error' && x.layer === view && x.pos != null).map((x) => x.pos));
  const snap = state.mode === 'sim' ? sim.snapshot() : null;
  const tested = state.test.tested[view] || new Set();

  // トラックボール
  const tb = h('div', {
    class: 'trackball' + (state.mode === 'sim' ? ' clickable' : '') + (snap?.mouseActive ? ' active' : ''),
    style: { left: (TRACKBALL.cx - TRACKBALL.r) * u + 'px', top: (TRACKBALL.cy - TRACKBALL.r - offY) * u + 'px', width: TRACKBALL.r * 2 * u + 'px', height: TRACKBALL.r * 2 * u + 'px' },
    title: state.mode === 'sim' ? 'クリックでトラックボール操作の ON / OFF（自動マウスレイヤー）' : 'トラックボール',
    onclick: () => { if (state.mode === 'sim') sim.setMouseActive(!sim.mouseActive); },
  }, state.mode === 'sim' ? (snap?.mouseActive ? '操作中' : 'トラック\nボール') : '');
  tb.style.whiteSpace = 'pre';
  board.append(tb);

  ZONKEY_LAYOUT.forEach((k, pos) => {
    let binding, fromLayer;
    if (state.mode === 'sim') {
      if (state.sim.viewLayer != null) ({ binding, layer: fromLayer } = effectiveBinding(view, pos));
      else ({ binding, layer: fromLayer } = sim.resolve(pos));
    } else {
      binding = state.layers[view]?.bindings[pos] || { behavior: 'none', params: [] };
    }
    const d = describeBinding(binding, c);
    let kind = d.kind;
    let tapText = d.tap;
    let holdText = d.hold || '';
    if (kind === 'trans') {
      const eff = effectiveBinding(view - 1, pos);
      const ed = describeBinding(eff.binding, c);
      tapText = '▽ ' + ed.tap;
      holdText = `L${eff.layer} から`;
    }
    const el = h('div', {
      class: `key k-${kind}`,
      dataset: { pos },
      title: `${positionName(pos)}\n${bindingToString(binding)}\n${d.desc}`,
      style: {
        left: k.x * u + 'px', top: (k.y - offY) * u + 'px',
      },
    });
    if (k.r) {
      el.style.transformOrigin = `${(k.rx - k.x) * u}px ${(k.ry - k.y) * u}px`;
      el.style.transform = `rotate(${k.r}deg)`;
    }
    const len = [...tapText].length;
    el.append(h('div', { class: 'tap' + (len > 7 ? ' xlong' : len > 3 ? ' long' : '') }, tapText));
    if (holdText) el.append(h('div', { class: 'hold' }, holdText));
    if (d.shift) el.append(h('div', { class: 'shift', title: 'Shift と一緒に押したとき' }, '⇧' + d.shift));
    if (state.mode === 'sim' && state.sim.pcKeys) el.append(h('div', { class: 'pc' }, pcKeyLabel(PC_KEYMAP[pos]?.[0])));
    if (state.mode === 'edit' && state.selected === pos) el.classList.add('selected');
    if (lintPos.has(pos) && state.mode !== 'sim') el.classList.add('bad');
    if (snap) {
      if (snap.pressed.includes(pos)) el.classList.add('pressed');
      if (snap.pendingPos === pos) el.classList.add('pressed', 'pending');
      if (snap.queued.includes(pos)) el.classList.add('queued');
      void fromLayer;
    }
    if (state.mode === 'test') {
      if (tested.has(pos)) el.classList.add('tested');
      if (!testUsages(view, pos).size) el.classList.add('untestable');
      if (state.test.flash?.includes(pos)) el.classList.add('flash');
    }
    if (state.mode === 'edit') {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(pos)); e.dataTransfer.effectAllowed = 'copyMove'; });
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
      el.addEventListener('dragleave', () => el.classList.remove('dragover'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData('text/plain'));
        if (isNaN(from) || from === pos) return;
        const copy = e.altKey || e.ctrlKey || e.metaKey;
        commit(() => {
          const L = state.layers[state.current].bindings;
          if (copy) L[pos] = cloneB(L[from]);
          else [L[from], L[pos]] = [L[pos], L[from]];
          state.selected = pos;
        });
        toast(copy ? 'キーをコピーしました' : 'キーを入れ替えました');
      });
    }
    board.append(el);
  });

  // 左右の目印
  board.append(h('div', { class: 'side-label', style: { left: '0px', top: (b.h - offY - 0.35) * u + 'px' } }, '左手'));
  board.append(h('div', { class: 'side-label', style: { left: (b.w - 1) * u + 'px', top: (b.h - offY - 0.35) * u + 'px' } }, '右手'));

  const hint = $('boardHint');
  hint.textContent = {
    edit: 'キーをクリックして編集。ドラッグで入れ替え（Alt/Ctrl を押しながらでコピー）。Delete で透過、Ctrl+C / Ctrl+V でコピー＆貼り付け。',
    sim: 'キーを押す（クリック / タッチ / PC のキーボード）と、PC に何が送られるかを確認できます。タッチ画面なら同時押しもできます。',
    test: 'Zonkey を接続してキーを押すと、届いたキーに ✓ が付きます。薄いキーはレイヤー切替などで、PC に信号を送らないため対象外です。',
    code: '',
  }[state.mode] || '';
}

let lintCache = null;
let lintCacheKey = '';
function runLintCached() {
  const key = JSON.stringify(state.layers.map((l) => l.bindings)) + state.host;
  if (key !== lintCacheKey) { lintCache = runLint(); lintCacheKey = key; }
  return lintCache;
}

// ---------------------------------------------------------------- 編集パネル

const pickerState = { tab: 'alpha', query: '' };
let captureHandler = null;

function setBinding(pos, b) {
  commit(() => { state.layers[state.current].bindings[pos] = b; });
}

function splitMods(expr) {
  let s = String(expr || '').replace(/\s+/g, '');
  let mods = 0;
  for (;;) {
    const m = /^([LR][CSAG])\((.*)\)$/.exec(s);
    if (!m) break;
    mods |= MOD_FUNCS[m[1]];
    s = m[2];
  }
  return { mods, base: s };
}
function joinMods(base, mods) {
  let s = base;
  const order = [['RG', 128], ['RA', 64], ['RS', 32], ['RC', 16], ['LG', 8], ['LA', 4], ['LS', 2], ['LC', 1]];
  for (const [fn, bit] of order) if (mods & bit) s = `${fn}(${s})`;
  return s;
}

function behaviorKeyParam(b) {
  if (b.behavior === 'kp') return b.params[0];
  if (b.behavior === 'lt' || b.behavior === 'mt') return b.params[1];
  const c = state.parsed?.behaviors?.[b.behavior];
  if (c?.compatible === 'zmk,behavior-hold-tap') return b.params[1];
  return null;
}
function behaviorLayerParam(b) {
  if (['mo', 'to', 'tog', 'sl', 'lt'].includes(b.behavior)) return b.params[0];
  return null;
}

function convertBinding(b, to) {
  const key = behaviorKeyParam(b) || 'A';
  const layer = behaviorLayerParam(b) ?? String(Math.min(1, state.layers.length - 1));
  const mod = b.behavior === 'mt' || b.behavior === 'sk' ? b.params[0] : 'LSHIFT';
  switch (to) {
    case 'kp': return { behavior: 'kp', params: [key] };
    case 'lt': return { behavior: 'lt', params: [layer, key] };
    case 'mt': return { behavior: 'mt', params: [mod, key] };
    case 'mo': case 'to': case 'tog': case 'sl': return { behavior: to, params: [layer] };
    case 'sk': return { behavior: 'sk', params: [mod] };
    case 'trans': case 'none': case 'caps_word': case 'key_repeat': case 'bootloader': case 'sys_reset': case 'studio_unlock':
      return { behavior: to, params: [] };
    case 'bt': return { behavior: 'bt', params: ['BT_SEL', '0'] };
    case 'mkp': return { behavior: 'mkp', params: ['MB1'] };
    default: {
      const c = state.parsed?.behaviors?.[to];
      if (!c) return { behavior: to, params: [] };
      if (c.compatible === 'zmk,behavior-hold-tap') return { behavior: to, params: [c.bindings[0]?.behavior === 'mo' ? layer : mod, key] };
      return { behavior: to, params: Array.from({ length: c.bindingCells || 0 }, () => key) };
    }
  }
}

const BEHAVIOR_CHOICES = [
  ['kp', 'キー入力', '普通のキー。Ctrl+C のような組み合わせも可'],
  ['lt', 'タップ／長押しでレイヤー', 'タップでキー、長押しでレイヤー'],
  ['mt', 'タップ／長押しで修飾', 'タップでキー、長押しで Shift や Ctrl'],
  ['mo', '押す間レイヤー', '押している間だけ別のレイヤー'],
  ['tog', 'レイヤー固定', '押すたびにレイヤーの ON / OFF'],
  ['to', 'レイヤー切替', 'そのレイヤーだけにする'],
  ['sl', 'ワンショットレイヤー', '次の 1 キーだけ別のレイヤー'],
  ['sk', 'ワンショット修飾', '次の 1 キーだけ Shift など'],
  ['trans', '透過 ▽', '下のレイヤーと同じ'],
  ['none', '無効 ✕', '何もしない'],
  ['bt', 'Bluetooth', '接続先の切替・ペアリング削除'],
  ['mkp', 'マウスボタン', 'クリック'],
  ['caps_word', 'Caps Word', '単語の間だけ大文字'],
  ['bootloader', '書込モード', 'ファーム書き込みモードに入る'],
];

function renderPanel() {
  ['Edit', 'Sim', 'Test', 'Code'].forEach((n) => $('panel' + n).classList.toggle('hidden', state.mode !== n.toLowerCase()));
  if (state.mode === 'edit') renderEditPanel();
  else if (state.mode === 'sim') renderSimPanel();
  else if (state.mode === 'test') renderTestPanel();
  else if (state.mode === 'code') renderCodePanel();
}

function renderEditPanel() {
  const panel = $('panelEdit');
  panel.replaceChildren();
  if (!state.parsed) return;
  const pos = state.selected;
  const layer = state.layers[state.current];
  const left = h('div');
  const right = h('div');
  panel.append(h('div', { class: 'grid2' }, left, right));

  if (pos == null) {
    left.append(
      h('h2', {}, 'キーを選んでください'),
      h('p', { class: 'muted' }, '上のキーボードでキーをクリックすると、ここで動作を変えられます。'),
      h('ul', { class: 'muted' },
        h('li', {}, '色の意味: 青＝レイヤー操作 / 黄＝タップと長押しで別動作 / 紫＝修飾 / 水色＝Shift で変化 / 緑＝マウス / 赤＝システム'),
        h('li', {}, '「▽」は透過キー。下のレイヤーのキーがそのまま使われます（薄字で表示）。'),
        h('li', {}, '右上の「⇧」は Shift と一緒に押したときの文字です。'),
        h('li', {}, '記号の表示は「PC の配列」に合わせています。JIS の PC で使うなら「日本語（JIS）」のままにしてください。'),
      ),
    );
  } else {
    const b = layer.bindings[pos];
    const d = describeBinding(b, ctx());
    left.append(
      h('h2', {}, `${positionName(pos)} ・ レイヤー${state.current}`),
      h('div', { class: 'desc' }, d.desc),
    );
    const codeIn = h('input', { type: 'text', class: 'code-input', value: bindingToString(b), spellcheck: false, 'aria-label': 'ZMK のコード' });
    const applyCode = () => {
      const nb = parseBindingString(codeIn.value);
      if (!nb) { toast('「&」で始まる ZMK のコードを入力してください'); return; }
      if (bindingToString(nb) !== bindingToString(b)) setBinding(pos, nb);
    };
    codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCode(); });
    left.append(h('h3', {}, 'ZMK のコード（直接編集もできます）'), h('div', { class: 'row' }, codeIn, h('button', { onclick: applyCode }, '適用')));

    // 動作の種類
    const customs = Object.values(state.parsed.behaviors).filter((x) => !/sensor-rotate/.test(x.compatible));
    const choices = h('div', { class: 'behaviors' });
    for (const [id, label, tip] of BEHAVIOR_CHOICES) {
      choices.append(h('button', {
        class: b.behavior === id ? 'active' : '', title: tip,
        onclick: () => { if (b.behavior !== id) setBinding(pos, convertBinding(b, id)); },
      }, label));
    }
    left.append(h('h3', {}, '動作の種類'), choices);
    if (customs.length) {
      const sel = h('select', {
        onchange: (e) => { if (e.target.value) setBinding(pos, convertBinding(b, e.target.value)); },
      }, h('option', { value: '' }, '— キーマップ内で定義された動作 —'),
      customs.map((c) => {
        const dd = describeBinding({ behavior: c.label, params: Array.from({ length: c.bindingCells || 0 }, () => 'A') }, ctx());
        const sum = c.compatible === 'zmk,behavior-mod-morph' ? `${dd.tap} / ⇧${dd.shift}` : c.compatible.replace('zmk,behavior-', '');
        return h('option', { value: c.label, selected: b.behavior === c.label }, `${c.label}（${sum}）`);
      }));
      left.append(h('div', { class: 'row', style: { marginTop: '6px' } }, sel));
    }

    left.append(h('div', { class: 'row', style: { marginTop: '12px' } },
      h('button', { onclick: () => { state.clipboard = cloneB(b); toast('コピーしました'); } }, 'コピー'),
      h('button', { disabled: !state.clipboard, onclick: () => state.clipboard && setBinding(pos, cloneB(state.clipboard)) }, '貼り付け'),
      h('button', { onclick: () => setBinding(pos, TRANS()) }, '透過にする'),
      h('button', { onclick: () => applyToAllLayersPrompt(pos, b) }, '全レイヤーに同じ設定'),
    ));

    renderParamEditor(right, pos, b);
  }

  // レイヤー設定
  const nameIn = h('input', { type: 'text', value: layer.displayName || '', placeholder: state.parsed.layers[layer.origIndex]?.nodeName || '名前なし' });
  nameIn.addEventListener('change', () => commit(() => { layer.displayName = nameIn.value.trim(); }));
  const sensIn = h('input', { type: 'text', class: 'code-input', value: layer.sensorBindings || '', placeholder: '例: <&inc_dec_kp C_VOL_DN C_VOL_UP>' });
  sensIn.addEventListener('change', () => commit(() => { layer.sensorBindings = sensIn.value.trim() || null; }));
  const isLast = state.current === state.layers.length - 1 && state.layers.length > 1;
  panel.append(h('details', { style: { marginTop: '14px' } },
    h('summary', {}, `レイヤー${state.current} の設定`),
    h('div', { class: 'grid2', style: { marginTop: '8px' } },
      h('label', { class: 'field' }, h('div', { class: 'muted' }, 'レイヤー名（display-name）'), nameIn),
      h('label', { class: 'field' }, h('div', { class: 'muted' }, 'エンコーダー（sensor-bindings）'), sensIn),
    ),
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { onclick: () => fillLayerPrompt() }, 'このレイヤーを全部「透過」にする'),
      h('button', { class: 'danger', disabled: !isLast, title: isLast ? '' : '番号がずれないよう、削除できるのは最後のレイヤーだけです', onclick: deleteLastLayer }, 'このレイヤーを削除'),
      state.current === state.mouseLayer ? h('span', { class: 'muted' }, '🖱 自動マウスレイヤー（トラックボールを動かすと有効）') : null,
    ),
  ));
}

function renderParamEditor(box, pos, b) {
  const params = b.params;
  const update = (i, v) => { const nb = cloneB(b); nb.params[i] = v; setBinding(pos, nb); };
  const custom = state.parsed.behaviors[b.behavior];

  const layerSelect = (i) => h('select', { onchange: (e) => update(i, e.target.value) },
    state.layers.map((l, li) => h('option', { value: String(li), selected: String(parseInt(expandDefines(params[i] ?? '', state.parsed.defines))) === String(li) }, `${li}: ${layerNames()[li]}`)));
  const modSelect = (i) => {
    const opts = [['LSHIFT', '左Shift'], ['LCTRL', '左Ctrl'], ['LALT', '左Alt'], ['LGUI', '左Win / Cmd'], ['RSHIFT', '右Shift'], ['RCTRL', '右Ctrl'], ['RALT', '右Alt'], ['RGUI', '右Win / Cmd'], ['LS(LCTRL)', 'Ctrl+Shift'], ['LA(LCTRL)', 'Ctrl+Alt']];
    const cur = params[i];
    const p = parseKeyExpr(expandDefines(cur ?? '', state.parsed.defines));
    const curUsage = p?.usage; const curMods = p?.mods;
    let matched = false;
    const sel = h('select', { onchange: (e) => update(i, e.target.value) }, opts.map(([v, l]) => {
      const q = parseKeyExpr(v);
      const sel = q.usage === curUsage && q.mods === curMods;
      if (sel) matched = true;
      return h('option', { value: v, selected: sel }, l);
    }));
    if (!matched && cur) sel.prepend(h('option', { value: cur, selected: true }, cur));
    return sel;
  };

  switch (b.behavior) {
    case 'kp':
      box.append(h('h2', {}, '送るキー'), keyPicker(params[0], (v) => update(0, v)));
      return;
    case 'lt':
      box.append(h('h2', {}, '長押ししたときのレイヤー'), layerSelect(0), timingNote(b.behavior));
      box.append(h('h2', { style: { marginTop: '14px' } }, 'タップしたときのキー'), keyPicker(params[1], (v) => update(1, v)));
      return;
    case 'mt':
      box.append(h('h2', {}, '長押ししたときの修飾キー'), modSelect(0), timingNote(b.behavior));
      box.append(h('h2', { style: { marginTop: '14px' } }, 'タップしたときのキー'), keyPicker(params[1], (v) => update(1, v)));
      return;
    case 'mo': case 'to': case 'tog': case 'sl':
      box.append(h('h2', {}, '対象のレイヤー'), layerSelect(0));
      if (b.behavior === 'mo' && state.layers.length) box.append(h('p', { class: 'muted' }, '押している間だけ、選んだレイヤーになります。'));
      if (b.behavior === 'tog' || b.behavior === 'to') box.append(h('p', { class: 'muted' }, '固定したレイヤーから戻るキーも用意しておきましょう（「コードとチェック」で確認できます）。'));
      return;
    case 'sk':
      box.append(h('h2', {}, '修飾キー'), modSelect(0));
      return;
    case 'bt': {
      const cmd = h('select', { onchange: (e) => { const nb = { behavior: 'bt', params: [e.target.value] }; if (['BT_SEL', 'BT_DISC'].includes(e.target.value)) nb.params.push(params[1] || '0'); setBinding(pos, nb); } },
        [['BT_SEL', '接続先を選ぶ'], ['BT_CLR', '今の接続先のペアリング削除'], ['BT_CLR_ALL', 'すべてのペアリング削除'], ['BT_NXT', '次の接続先'], ['BT_PRV', '前の接続先'], ['BT_DISC', '接続先を切断']]
          .map(([v, l]) => h('option', { value: v, selected: params[0] === v }, l)));
      box.append(h('h2', {}, 'Bluetooth の操作'), cmd);
      if (['BT_SEL', 'BT_DISC'].includes(params[0])) {
        box.append(h('div', { class: 'row', style: { marginTop: '8px' } }, '接続先番号',
          h('select', { onchange: (e) => update(1, e.target.value) }, [0, 1, 2, 3, 4].map((n) => h('option', { value: String(n), selected: params[1] === String(n) }, `${n}`)))));
      }
      return;
    }
    case 'mkp':
      box.append(h('h2', {}, 'マウスボタン'), h('select', { onchange: (e) => update(0, e.target.value) },
        [['MB1', '左クリック'], ['MB2', '右クリック'], ['MB3', '中クリック'], ['MB4', '戻る'], ['MB5', '進む']].map(([v, l]) => h('option', { value: v, selected: params[0] === v }, l))));
      return;
    case 'trans':
      box.append(h('h2', {}, '透過'), h('p', { class: 'muted' }, 'このキーは下のレイヤー（たいていはレイヤー0）のキーと同じ動きになります。'));
      return;
    case 'none':
      box.append(h('h2', {}, '無効'), h('p', { class: 'muted' }, '押しても何も起きません。下のレイヤーのキーも使われません。'));
      return;
    default: break;
  }
  if (custom) {
    if (custom.compatible === 'zmk,behavior-hold-tap') {
      const holdIsLayer = custom.bindings[0]?.behavior === 'mo';
      box.append(h('h2', {}, holdIsLayer ? '長押ししたときのレイヤー' : '長押ししたときのキー'), holdIsLayer ? layerSelect(0) : modSelect(0), timingNote(b.behavior));
      box.append(h('h2', { style: { marginTop: '14px' } }, 'タップしたときのキー'), keyPicker(params[1], (v) => update(1, v)));
      return;
    }
    if (custom.compatible === 'zmk,behavior-mod-morph') {
      const d = describeBinding(b, ctx());
      box.append(h('h2', {}, `「${b.behavior}」の中身`), h('p', {}, d.desc),
        h('p', { class: 'muted' }, 'この動作の中身はキーマップの behaviors で定義されています。中身を変えたいときは「コードとチェック」から .keymap を直接編集してください。'));
      return;
    }
    if (custom.bindingCells >= 1) {
      box.append(h('h2', {}, 'パラメーター'), keyPicker(params[0], (v) => update(0, v)));
      return;
    }
  }
  box.append(h('h2', {}, 'パラメーター'), h('p', { class: 'muted' }, '左の「ZMK のコード」欄で直接編集できます。'));
}

function timingNote(name) {
  const cfg = describeBinding({ behavior: name, params: ['0', 'A'] }, ctx());
  const m = /判定 (\d+)ms・(.+?)）/.exec(cfg.desc);
  return m ? h('p', { class: 'muted', style: { fontSize: '12px' } }, `長押しの判定: ${m[1]}ms（${m[2]}）。シミュレーターで実際の感覚を試せます。`) : null;
}

function keyPicker(current, onPick) {
  const wrap = h('div');
  const { mods, base } = splitMods(expandDefines(current || '', null));
  const curParsed = parseKeyExpr(expandDefines(current || '', state.parsed.defines));
  const host = state.host;

  // 現在
  const label = curParsed ? keyLabel(curParsed, host).main : (current || '未設定');
  wrap.append(h('div', { class: 'row' },
    h('span', {}, '現在: ', h('b', {}, label), ' ', h('code', { class: 'muted' }, current || '')),
  ));

  // 修飾
  const modBox = h('div', { class: 'mods', style: { margin: '6px 0' } });
  for (const [fn, name] of [['LC', 'Ctrl'], ['LS', 'Shift'], ['LA', 'Alt'], ['LG', 'Win/Cmd']]) {
    const bit = MOD_FUNCS[fn];
    const cb = h('input', { type: 'checkbox', checked: !!(mods & bit) });
    cb.addEventListener('change', () => onPick(joinMods(base || 'A', cb.checked ? mods | bit : mods & ~bit)));
    modBox.append(h('label', {}, cb, `+ ${name}`));
  }
  wrap.append(h('div', { class: 'muted', style: { fontSize: '12px' } }, '一緒に押す修飾キー（ショートカット用）'), modBox);

  // PC のキーで指定
  const capBtn = h('button', { class: 'capture' }, '⌨ PC のキーを押して指定');
  capBtn.addEventListener('click', () => {
    if (captureHandler) { stopCapture(); return; }
    capBtn.classList.add('listening');
    capBtn.textContent = '指定したいキーを押してください（Esc でやめる）';
    captureHandler = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape' && !e.shiftKey) { stopCapture(); return; }
      const k = keyByCode(e.code);
      if (!k) { toast(`このキー（${e.code}）は対応していません`); return; }
      if (MOD_USAGE_BIT[k.usage]) {
        // 修飾キー単体はキーアップで確定
        return;
      }
      let m = 0;
      if (e.ctrlKey) m |= MOD_FUNCS.LC;
      if (e.shiftKey) m |= MOD_FUNCS.LS;
      if (e.altKey) m |= MOD_FUNCS.LA;
      if (e.metaKey) m |= MOD_FUNCS.LG;
      stopCapture();
      onPick(joinMods(k.name, m));
    };
    captureUpHandler = (e) => {
      const k = keyByCode(e.code);
      if (k && MOD_USAGE_BIT[k.usage]) { e.preventDefault(); stopCapture(); onPick(k.name); }
    };
    window.addEventListener('keydown', captureHandler, true);
    window.addEventListener('keyup', captureUpHandler, true);
  });
  wrap.append(capBtn);

  // 検索とカテゴリ
  const search = h('input', { type: 'text', placeholder: '検索（例: enter, 変換, @, F5）', value: pickerState.query, style: { width: '100%', marginTop: '8px' } });
  const tabs = h('div', { class: 'picker-tabs' });
  const grid = h('div', { class: 'keygrid' });
  const allTabs = [['jischar', host === 'jis' ? '記号（JIS で出したい文字）' : '記号（出したい文字）'], ...CATEGORIES];
  const drawTabs = () => {
    tabs.replaceChildren(...allTabs.map(([id, name]) => h('button', {
      class: pickerState.tab === id && !pickerState.query ? 'active' : '',
      onclick: () => { pickerState.tab = id; pickerState.query = ''; search.value = ''; drawTabs(); drawGrid(); },
    }, name)));
  };
  const curUsage = curParsed?.usage;
  const curModsAll = curParsed?.mods ?? -1;
  const drawGrid = () => {
    grid.replaceChildren();
    const q = pickerState.query.trim().toLowerCase();
    let items;
    if (q) {
      const chars = charTable(host).filter((c) => c.ch.toLowerCase() === q).map((c) => ({ expr: c.expr, label: c.ch, sub: c.expr }));
      const keys = KEYS.filter((k) => k.names.some((n) => n.toLowerCase().includes(q)) || k.ja.toLowerCase().includes(q) ||
        String(host === 'jis' ? k.jis : k.us).toLowerCase() === q)
        .map((k) => ({ expr: k.name, label: keyLabel(k.name, host).main, sub: k.ja !== keyLabel(k.name, host).main ? k.ja : k.name }));
      items = [...chars, ...keys].slice(0, 120);
    } else if (pickerState.tab === 'jischar') {
      items = charTable(host).map((c) => ({ expr: c.expr, label: c.ch, sub: c.expr }));
    } else {
      items = KEYS.filter((k) => k.cat === pickerState.tab).map((k) => ({ expr: k.name, label: keyLabel(k.name, host).main, sub: k.ja !== keyLabel(k.name, host).main ? k.ja : '' }));
    }
    if (!items.length) grid.append(h('div', { class: 'muted' }, '見つかりません'));
    for (const it of items) {
      const p = parseKeyExpr(it.expr);
      const active = p && p.usage === curUsage && p.mods === curModsAll;
      grid.append(h('button', {
        class: active ? 'active' : '', title: it.expr,
        onclick: () => {
          // 文字指定（LS(..) 付き）はそのまま、キー指定は今の修飾を引き継ぐ
          const keep = pickerState.tab === 'jischar' || /^L[CSAG]\(/.test(it.expr) || isShiftedAlias(it.expr) ? 0 : mods;
          onPick(joinMods(it.expr, keep));
        },
      }, it.label, it.sub ? h('small', {}, it.sub) : null));
    }
  };
  search.addEventListener('input', () => { pickerState.query = search.value; drawTabs(); drawGrid(); });
  drawTabs(); drawGrid();
  wrap.append(search, tabs, grid);
  return wrap;
}

let captureUpHandler = null;

function selectKey(pos) {
  state.selected = pos;
  const b = state.layers[state.current]?.bindings[pos];
  const kp = b && behaviorKeyParam(b);
  const p = kp && parseKeyExpr(expandDefines(kp, state.parsed?.defines));
  pickerState.query = '';
  if (p?.key) pickerState.tab = (p.mods & 2) && ['num', 'sym', 'ja'].includes(p.key.cat) ? 'jischar' : p.key.cat;
  renderBoard();
  renderEditPanel();
}
function stopCapture() {
  if (captureHandler) window.removeEventListener('keydown', captureHandler, true);
  if (captureUpHandler) window.removeEventListener('keyup', captureUpHandler, true);
  captureHandler = null; captureUpHandler = null;
  document.querySelectorAll('.capture.listening').forEach((b) => { b.classList.remove('listening'); b.textContent = '⌨ PC のキーを押して指定'; });
}

function renameLayer(i) {
  const cur = state.layers[i].displayName || '';
  openDialog((form, close) => {
    const inp = h('input', { type: 'text', value: cur, placeholder: '例: 数字・記号' });
    form.append(h('h2', {}, `レイヤー${i} の名前`), inp,
      h('div', { class: 'note' }, '.keymap の display-name として保存されます。ZMK Studio などでも表示されます。'),
      h('div', { class: 'footer' }, h('button', { value: 'cancel', onclick: close }, 'キャンセル'),
        h('button', { class: 'primary', onclick: (e) => { e.preventDefault(); commit(() => { state.layers[i].displayName = inp.value.trim(); }); close(); } }, '変更')));
    setTimeout(() => inp.focus(), 0);
  });
}

function addLayer() {
  commit(() => {
    state.layers.push({ origIndex: null, displayName: `layer ${state.layers.length}`, bindings: Array.from({ length: KEY_COUNT }, TRANS), sensorBindings: null });
    state.current = state.layers.length - 1;
    state.selected = null;
  });
  toast(`レイヤー${state.current} を追加しました。ほかのレイヤーに切り替えキー（lt / mo など）を置きましょう。`, 4000);
}

function deleteLastLayer() {
  const i = state.layers.length - 1;
  const refs = runLint().length; void refs;
  if (!confirm(`レイヤー${i}「${layerNames()[i]}」を削除しますか？${i === state.mouseLayer ? '\n※ 自動マウスレイヤーです。削除するとトラックボールのクリックが使えなくなる可能性があります。' : ''}`)) return;
  commit(() => { state.layers.pop(); state.current = Math.min(state.current, state.layers.length - 1); });
}

function fillLayerPrompt() {
  if (!confirm(`レイヤー${state.current} のキーをすべて「透過」にしますか？`)) return;
  commit(() => { state.layers[state.current].bindings = Array.from({ length: KEY_COUNT }, TRANS); });
}

function applyToAllLayersPrompt(pos, b) {
  if (!confirm(`この位置のキーを、すべてのレイヤーで「${bindingToString(b)}」にしますか？\n（レイヤー0 以外は「透過」にするほうが一般的です）`)) return;
  commit(() => { state.layers.forEach((l) => { l.bindings[pos] = cloneB(b); }); });
}

// ---------------------------------------------------------------- シミュレーターパネル

function renderSimPanel() {
  const panel = $('panelSim');
  panel.replaceChildren();
  const pcCb = h('input', { type: 'checkbox', checked: state.sim.pcKeys, onchange: (e) => { state.sim.pcKeys = e.target.checked; renderBoard(); } });
  const latchCb = h('input', { type: 'checkbox', checked: state.sim.latch, onchange: (e) => { state.sim.latch = e.target.checked; } });
  const mouseBtn = h('button', { id: 'simMouseBtn', onclick: () => sim.setMouseActive(!sim.mouseActive) });
  const out = h('textarea', { id: 'simOut', class: 'sim-output', readOnly: true, placeholder: 'ここに入力結果が表示されます' });
  const left = h('div', {},
    h('h2', {}, '入力結果（PC に届く文字）'),
    out,
    h('div', { class: 'row', style: { marginTop: '6px' } },
      h('button', { onclick: () => sim.clearOutput() }, 'クリア'),
      h('button', { onclick: () => { releaseAllPointers(); sim.reset(); toast('状態をリセットしました'); } }, 'すべて離す / リセット'),
    ),
    h('h3', {}, '送信されたキー（新しい順）'),
    h('div', { id: 'simChips', class: 'chips' }),
  );
  const right = h('div', {},
    h('h2', {}, '今の状態'),
    h('div', { id: 'simState', class: 'state' }),
    h('h3', {}, '操作方法'),
    h('label', { class: 'toggle' }, pcCb, 'PC のキーボードで押す（キーに割り当てを表示）'),
    h('label', { class: 'toggle' }, latchCb, 'クリックで押しっぱなしにする（もう一度クリックで離す）'),
    h('div', { class: 'row', style: { marginTop: '6px' } }, mouseBtn),
    h('p', { class: 'muted', style: { fontSize: '12px' } }, '右クリックでも、そのキーだけ押しっぱなしにできます。長押し判定は実機と同じ時間で行います。'),
    h('h3', {}, '動作ログ'),
    h('ul', { id: 'simLog', class: 'log' }),
  );
  panel.append(h('div', { class: 'grid2' }, left, right));
  updateSimPanel();
}

function updateSimPanel() {
  if (state.mode !== 'sim' || !$('simOut')) return;
  const s = sim.snapshot();
  const out = $('simOut');
  if (out.value !== s.text) { out.value = s.text; out.scrollTop = out.scrollHeight; }
  const chips = $('simChips');
  chips.replaceChildren(...s.reports.slice(-60).reverse().map((r) => h('span', { class: 'chip ' + r.kind }, r.label, r.out && r.out !== r.label ? h('b', {}, '→ ' + r.out) : null)));
  const st = $('simState');
  const names = layerNames();
  st.replaceChildren(...[
    ...s.activeLayers.map((l) => h('span', { class: 'pill on' }, `L${l} ${names[l]}`)),
    ...[['Ctrl', 17], ['Shift', 34], ['Alt', 68], ['Win', 136]].map(([n, m]) => h('span', { class: 'pill' + (s.mods & m ? ' on' : '') }, n)),
    s.capsWord ? h('span', { class: 'pill on' }, 'CapsWord') : null,
    s.pendingPos != null ? h('span', { class: 'pill on' }, 'タップ／長押し 判定中…') : null,
  ].filter(Boolean));
  const log = $('simLog');
  log.replaceChildren(...s.log.slice(-80).reverse().map((l) => h('li', { class: l.kind }, l.msg)));
  const mb = $('simMouseBtn');
  if (mb) {
    mb.disabled = state.mouseLayer == null;
    mb.textContent = state.mouseLayer == null ? '自動マウスレイヤーなし' : (s.mouseActive ? '🖱 トラックボール操作を止める' : `🖱 トラックボールを動かす（L${state.mouseLayer} を有効に）`);
    mb.className = s.mouseActive ? 'primary' : '';
  }
}

const pointerPos = new Map();
const latched = new Set();
function releaseAllPointers() {
  for (const pos of pointerPos.values()) sim.release(pos);
  pointerPos.clear();
  for (const pos of latched) sim.release(pos);
  latched.clear();
}

function setupBoardPointer() {
  const board = $('board');
  board.addEventListener('contextmenu', (e) => { if (state.mode === 'sim' && e.target.closest('.key')) e.preventDefault(); });
  board.addEventListener('pointerdown', (e) => {
    const keyEl = e.target.closest('.key');
    if (!keyEl) return;
    const pos = parseInt(keyEl.dataset.pos);
    if (state.mode === 'edit') { selectKey(pos); return; }
    if (state.mode !== 'sim') return;
    e.preventDefault();
    if (state.sim.latch || e.button === 2) {
      if (latched.has(pos)) { latched.delete(pos); sim.release(pos); } else { latched.add(pos); sim.press(pos); }
      return;
    }
    if (latched.has(pos)) { latched.delete(pos); sim.release(pos); return; }
    try { board.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    pointerPos.set(e.pointerId, pos);
    sim.press(pos);
  });
  const up = (e) => {
    if (!pointerPos.has(e.pointerId)) return;
    const pos = pointerPos.get(e.pointerId);
    pointerPos.delete(e.pointerId);
    sim.release(pos);
  };
  board.addEventListener('pointerup', up);
  board.addEventListener('pointercancel', up);
}

const pcDown = new Map(); // code → pos
function pcPosFor(code) {
  return PC_KEYMAP.findIndex((codes) => codes.includes(code));
}

// ---------------------------------------------------------------- 実機テストパネル

/** その位置（レイヤー表示上）を押したときに PC に届きうる HID usage */
function testUsages(layerIdx, pos) {
  const { binding } = effectiveBinding(layerIdx, pos);
  const out = new Set();
  const addKey = (expr) => { const p = parseKeyExpr(expandDefines(expr ?? '', state.parsed?.defines)); if (p && p.key) out.add(p.usage); };
  const visit = (b, depth = 0) => {
    if (!b || depth > 4) return;
    const custom = state.parsed?.behaviors?.[b.behavior];
    if (b.behavior === 'kp') addKey(b.params[0]);
    else if (b.behavior === 'lt') addKey(b.params[1]);
    else if (b.behavior === 'mt') { addKey(b.params[0]); addKey(b.params[1]); }
    else if (custom?.compatible === 'zmk,behavior-hold-tap') {
      visit({ behavior: custom.bindings[0]?.behavior, params: [...(custom.bindings[0]?.params || []), b.params[0]] }, depth + 1);
      visit({ behavior: custom.bindings[1]?.behavior, params: [...(custom.bindings[1]?.params || []), b.params[1]] }, depth + 1);
    } else if (custom?.compatible === 'zmk,behavior-mod-morph') custom.bindings.forEach((x) => visit(x, depth + 1));
  };
  visit(binding);
  return out;
}

function renderTestPanel() {
  const panel = $('panelTest');
  panel.replaceChildren();
  const startBtn = h('button', { id: 'testStart', class: 'primary', onclick: () => { state.test.on = !state.test.on; updateTestPanel(); } });
  panel.append(h('div', { class: 'grid2' },
    h('div', {},
      h('h2', {}, '実機でキーマップを確認'),
      h('ol', { class: 'muted', style: { paddingLeft: '18px', margin: '4px 0 10px' } },
        h('li', {}, 'ファームウェアを書き込んだ Zonkey を PC に接続（USB / Bluetooth）'),
        h('li', {}, '確認したいレイヤーを上のタブで選ぶ（レイヤー1 なら実機でもそのレイヤーキーを押しながら）'),
        h('li', {}, '「テスト開始」を押してから Zonkey のキーを順に押す'),
      ),
      h('div', { id: 'testArea', class: 'capture-area' }),
      h('div', { class: 'row', style: { marginTop: '8px' } }, startBtn,
        h('button', { onclick: () => { state.test.tested[viewLayer()] = new Set(); state.test.last = null; renderBoard(); updateTestPanel(); } }, 'このレイヤーの記録をリセット')),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, 'テスト中はキー入力をこのページが受け取ります（Win キーや一部のショートカットは OS が先に処理するため届かないことがあります）。IME がオンでも判定できます。'),
    ),
    h('div', {},
      h('h2', {}, '進み具合'),
      h('div', { id: 'testProgress' }),
      h('h3', {}, '受信したキー'),
      h('ul', { id: 'testLog', class: 'log' }),
    ),
  ));
  updateTestPanel();
}

const testLog = [];
function updateTestPanel() {
  if (state.mode !== 'test' || !$('testArea')) return;
  const L = viewLayer();
  const testable = ZONKEY_LAYOUT.map((_, pos) => pos).filter((pos) => testUsages(L, pos).size);
  const tested = state.test.tested[L] || new Set();
  const done = testable.filter((p) => tested.has(p)).length;
  $('testStart').textContent = state.test.on ? '⏸ テストを止める' : '▶ テスト開始';
  const area = $('testArea');
  area.classList.toggle('on', state.test.on);
  const last = state.test.last;
  area.replaceChildren(...[
    state.test.on ? h('div', { class: 'muted' }, `レイヤー${L} をテスト中。Zonkey のキーを押してください。`) : h('div', { class: 'muted' }, '「テスト開始」を押すと、ここでキー入力を受け取ります。'),
    last ? h('div', { class: 'big-event' }, last.title) : null,
    last ? h('div', {}, last.detail) : null,
  ].filter(Boolean));
  $('testProgress').replaceChildren(...[
    h('div', {}, `レイヤー${L}: ${done} / ${testable.length} キー確認済み`),
    h('div', { class: 'progress' }, h('div', { style: { width: (testable.length ? (done / testable.length) * 100 : 0) + '%' } })),
    done === testable.length && testable.length ? h('p', { style: { color: 'var(--ok)' } }, '🎉 このレイヤーのキーはすべて確認できました') : null,
  ].filter(Boolean));
  $('testLog').replaceChildren(...testLog.slice(-50).reverse().map((t) => h('li', { class: t.kind }, t.msg)));
}

function onTestKey(e) {
  e.preventDefault();
  if (e.repeat) return;
  const L = viewLayer();
  const k = keyByCode(e.code);
  const names = [];
  if (e.ctrlKey && !/Control/.test(e.code)) names.push('Ctrl');
  if (e.shiftKey && !/Shift/.test(e.code)) names.push('Shift');
  if (e.altKey && !/Alt/.test(e.code)) names.push('Alt');
  if (e.metaKey && !/Meta|OS/.test(e.code)) names.push('Win');
  const keyName = k ? keyLabel(k.name, state.host).main : e.code;
  const title = [...names, keyName].join(' + ');
  if (!state.test.tested[L]) state.test.tested[L] = new Set();
  const tested = state.test.tested[L];
  let detail;
  let kind = 'info';
  if (!k) {
    detail = `対応表にないキーです（code: ${e.code}, key: ${e.key}）`;
    kind = 'warn';
  } else {
    const cands = ZONKEY_LAYOUT.map((_, pos) => pos).filter((pos) => testUsages(L, pos).has(k.usage));
    if (cands.length) {
      const target = cands.find((p) => !tested.has(p)) ?? cands[0];
      tested.add(target);
      state.test.flash = cands;
      setTimeout(() => { state.test.flash = null; if (state.mode === 'test') renderBoard(); }, 400);
      detail = `${positionName(target)} のキーとして確認しました${cands.length > 1 ? `（同じキーが ${cands.length} か所にあります）` : ''}`;
    } else {
      const others = state.layers.map((_, li) => li).filter((li) => li !== L && ZONKEY_LAYOUT.some((_, pos) => testUsages(li, pos).has(k.usage)));
      detail = `レイヤー${L} にはこのキーがありません。${others.length ? `レイヤー ${others.join(', ')} にあります。` : 'キーマップのどこにもありません（ファームウェアが古い可能性があります）。'}`;
      kind = 'warn';
    }
  }
  state.test.last = { title, detail };
  testLog.push({ msg: `${title} (${e.code}) — ${detail}`, kind });
  if (testLog.length > 200) testLog.shift();
  renderBoard();
  updateTestPanel();
}

// ---------------------------------------------------------------- コードパネル

function renderCodePanel() {
  const panel = $('panelCode');
  panel.replaceChildren();
  const text = output();
  const lint = runLint();
  const ta = h('textarea', { class: 'code', spellcheck: false });
  ta.value = text;
  const changedKeys = countChanges();
  const mkItem = (it) => h('li', {
    class: it.level,
    title: it.layer != null ? 'クリックでそのキーへ移動' : '',
    onclick: () => { if (it.layer != null) { state.current = it.layer; setMode('edit'); if (it.pos != null) selectKey(it.pos); } },
  }, it.msg);
  const problems = lint.filter((x) => x.level !== 'info').sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1));
  const infos = lint.filter((x) => x.level === 'info');
  const lintList = h('div', {},
    h('ul', { class: 'lint' }, problems.length ? problems.map(mkItem) : h('li', { class: 'info' }, '問題は見つかりませんでした。')),
    infos.length ? h('details', { style: { marginTop: '8px' } },
      h('summary', {}, `💡 JIS 配列での注意（${infos.length} 件）`),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, 'ZMK のキー名は US 配列が基準です。キーボード上の表示は「JIS の PC で実際に出る文字」にしてあるので、表示が意図どおりなら問題ありません。'),
      h('ul', { class: 'lint' }, infos.map(mkItem))) : null,
  );
  panel.append(h('div', { class: 'grid2' },
    h('div', {},
      h('h2', {}, '自動チェック'),
      h('p', { class: 'muted', style: { fontSize: '12px' } }, '⛔ ビルドが失敗する・動かない可能性　⚠️ 意図と違うかもしれない　💡 JIS 配列での注意'),
      lintList,
    ),
    h('div', {},
      h('h2', {}, '書き出される .keymap'),
      h('p', { class: 'muted' }, changedKeys ? `変更: ${changedKeys}` : '読み込んだときから変更はありません。'),
      h('div', { class: 'row', style: { marginBottom: '6px' } },
        h('button', { onclick: () => copyText(text) }, 'コピー'),
        h('button', { onclick: () => download(text) }, 'ダウンロード'),
        h('button', { onclick: () => { applyEditedSource(ta.value); } }, 'このテキストを反映（直接編集した場合）'),
      ),
      ta,
    ),
  ));
}

function countChanges() {
  const parts = [];
  let keys = 0;
  state.layers.forEach((l) => {
    if (l.origIndex == null) return;
    const o = state.parsed.layers[l.origIndex];
    l.bindings.forEach((b, i) => { if (!o.bindings[i] || bindingToString(b) !== bindingToString(o.bindings[i])) keys++; });
  });
  if (keys) parts.push(`キー ${keys} 個`);
  const added = state.layers.filter((l) => l.origIndex == null).length;
  if (added) parts.push(`追加レイヤー ${added}`);
  const removed = state.parsed.layers.length - state.layers.filter((l) => l.origIndex != null).length;
  if (removed) parts.push(`削除レイヤー ${removed}`);
  return parts.join('、');
}

function applyEditedSource(text) {
  const p = parseKeymap(text);
  if (p.errors.length) { alert('解析できませんでした:\n' + p.errors.join('\n')); return; }
  if (text === output()) { toast('変更はありません'); return; }
  const base = state.baseText;
  setBase(text, state.origin, { keepView: true });
  state.baseText = base; // 保存するまでは「未保存」のまま
  changed();
  toast('テキストを反映しました（保存するまで GitHub には反映されません）');
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('コピーしました'), () => toast('コピーできませんでした'));
}
function download(text, name) {
  const fn = name || (state.origin.path ? state.origin.path.split('/').pop() : state.origin.name && /\.keymap$/.test(state.origin.name) ? state.origin.name : 'zonkey.keymap');
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: fn });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`${fn} をダウンロードしました`);
}

// ---------------------------------------------------------------- ダイアログ

function openDialog(build) {
  const dlg = $('dlg');
  const form = $('dlgBody');
  form.replaceChildren();
  const close = (e) => { if (e) e.preventDefault(); dlg.close(); };
  build(form, close);
  dlg.showModal();
}

function ghSettings() { return store.get(GH_KEY) || { owner: '', repo: '', branch: '', path: '' }; }
let sessionToken = null;
function getToken() { return sessionToken || store.get(TOKEN_KEY) || ''; }

function confirmDiscard() {
  return !isDirty() || confirm('保存していない変更があります。破棄して読み込みますか？');
}

function openLoadDialog() {
  openDialog((form, close) => {
    let tab = 'github';
    const body = h('div');
    const tabs = h('div', { class: 'tabs' });
    const err = h('div', { class: 'err' });
    const draw = () => {
      tabs.replaceChildren(...[['github', 'GitHub から'], ['file', 'ファイル'], ['paste', '貼り付け'], ['official', '公式デフォルト'], ['template', '新規']].map(([id, n]) =>
        h('button', { class: tab === id ? 'active' : '', onclick: (e) => { e.preventDefault(); tab = id; err.textContent = ''; draw(); } }, n)));
      body.replaceChildren();
      if (tab === 'github') body.append(githubForm(err, close, 'load'));
      if (tab === 'file') {
        const inp = h('input', { type: 'file', accept: '.keymap,.dtsi,.txt' });
        inp.addEventListener('change', async () => {
          const f = inp.files[0];
          if (!f) return;
          try { if (!confirmDiscard()) return; setBase(await f.text(), { type: 'file', name: f.name }); close(); toast(`${f.name} を読み込みました`); } catch (e) { err.textContent = e.message; }
        });
        body.append(h('p', {}, 'zmk-config の config/zonkey.keymap を選んでください。'), inp);
      }
      if (tab === 'paste') {
        const ta = h('textarea', { class: 'code', placeholder: '.keymap の中身を貼り付け' });
        body.append(ta, h('div', { class: 'footer' }, h('button', {
          class: 'primary', onclick: (e) => {
            e.preventDefault();
            try { if (!confirmDiscard()) return; setBase(ta.value, { type: 'paste', name: '' }); close(); toast('読み込みました'); } catch (x) { err.textContent = x.message; }
          },
        }, '読み込む')));
      }
      if (tab === 'official') {
        body.append(h('p', {}, 'Zonkey の公式リポジトリ（kureyakey/zmk-config-zonkey）のデフォルトキーマップを読み込みます。'),
          h('div', { class: 'footer' }, h('button', {
            class: 'primary', onclick: async (e) => {
              e.preventDefault();
              try { if (!confirmDiscard()) return; setBase(await GH.fetchOfficial(), { type: 'official', name: '' }); close(); toast('公式キーマップを読み込みました'); } catch (x) { err.textContent = x.message; }
            },
          }, '読み込む')));
      }
      if (tab === 'template') {
        body.append(h('p', {}, '最小限のひな形から始めます（behaviors の定義などはありません）。'),
          h('div', { class: 'footer' }, h('button', {
            class: 'primary', onclick: (e) => { e.preventDefault(); if (!confirmDiscard()) return; setBase(templateKeymap(), { type: 'template', name: '' }); close(); },
          }, 'ひな形を使う')));
      }
    };
    draw();
    form.append(h('h2', {}, 'キーマップを読み込む'), tabs, body, err, h('div', { class: 'footer' }, h('button', { onclick: close }, '閉じる')));
  });
}

function githubForm(err, close, purpose) {
  const s = ghSettings();
  if (state.origin.type === 'github') Object.assign(s, { owner: state.origin.owner, repo: state.origin.repo, branch: state.origin.branch, path: state.origin.path });
  const repoIn = h('input', { type: 'text', value: s.owner ? `${s.owner}/${s.repo}` : '', placeholder: '例: yourname/zmk-config-zonkey' });
  const branchIn = h('input', { type: 'text', value: s.branch || '', placeholder: '空欄ならデフォルトブランチ' });
  const pathIn = h('input', { type: 'text', value: s.path || 'config/zonkey.keymap' });
  const tokenIn = h('input', { type: 'password', value: getToken(), placeholder: 'github_pat_...（公開リポジトリの読み込みだけなら空欄で OK）', autocomplete: 'off' });
  const remember = h('input', { type: 'checkbox', checked: !!store.get(TOKEN_KEY) });
  const busy = (btn, on) => { btn.disabled = on; };
  const findBtn = h('button', {
    onclick: async (e) => {
      e.preventDefault(); err.textContent = '';
      const r = GH.parseRepo(repoIn.value);
      if (!r) { err.textContent = 'リポジトリを「ユーザー名/リポジトリ名」の形で入力してください'; return; }
      try {
        busy(findBtn, true);
        const token = tokenIn.value.trim();
        const branch = branchIn.value.trim() || await GH.getDefaultBranch({ ...r, token });
        branchIn.value = branch;
        const list = await GH.findKeymaps({ ...r, branch, token });
        if (!list.length) err.textContent = '.keymap ファイルが見つかりませんでした';
        else { pathIn.value = list.find((p) => /zonkey/i.test(p)) || list[0]; if (list.length > 1) toast(`見つかったファイル: ${list.join(', ')}`, 5000); }
      } catch (x) { err.textContent = x.message; } finally { busy(findBtn, false); }
    },
  }, '.keymap を探す');

  const saveSettings = () => {
    const r = GH.parseRepo(repoIn.value);
    store.set(GH_KEY, { owner: r?.owner || '', repo: r?.repo || '', branch: branchIn.value.trim(), path: pathIn.value.trim() });
    const token = tokenIn.value.trim();
    sessionToken = token || null;
    if (remember.checked && token) store.set(TOKEN_KEY, token); else store.del(TOKEN_KEY);
    return { ...r, branch: branchIn.value.trim(), path: pathIn.value.trim(), token };
  };

  const wrap = h('div', { style: { display: 'grid', gap: '8px' } },
    h('label', { class: 'field' }, h('span', {}, 'リポジトリ（Zonkey の zmk-config）'), repoIn),
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'ブランチ'), branchIn),
      h('label', { class: 'field' }, h('span', {}, 'ファイルのパス'), h('div', { class: 'row' }, pathIn, findBtn)),
    ),
    h('label', { class: 'field' }, h('span', {}, 'アクセストークン（保存・非公開リポジトリに必要）'), tokenIn),
    h('label', { class: 'toggle' }, remember, 'このブラウザにトークンを記憶する'),
    h('details', { class: 'note' }, h('summary', {}, 'トークンの作り方'),
      h('ol', { style: { paddingLeft: '18px', margin: '6px 0' } },
        h('li', {}, 'GitHub の Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token'),
        h('li', {}, 'Repository access で「Only select repositories」→ zmk-config-zonkey を選ぶ'),
        h('li', {}, 'Permissions の「Contents」を Read and write にする'),
        h('li', {}, '作成したトークン（github_pat_…）を上に貼り付け'),
      ),
      h('div', {}, 'トークンはこのブラウザの中だけで使われ、GitHub 以外には送られません。'),
    ),
  );
  if (purpose === 'load') {
    const loadBtn = h('button', {
      class: 'primary', onclick: async (e) => {
        e.preventDefault(); err.textContent = '';
        const cfg = saveSettings();
        if (!cfg.owner) { err.textContent = 'リポジトリを入力してください'; return; }
        try {
          loadBtn.disabled = true;
          if (!cfg.branch) { cfg.branch = await GH.getDefaultBranch(cfg); branchIn.value = cfg.branch; saveSettings(); }
          const f = await GH.getFile(cfg);
          if (!confirmDiscard()) return;
          setBase(f.text, { type: 'github', owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, path: cfg.path, sha: f.sha });
          close();
          toast(`${cfg.owner}/${cfg.repo} から読み込みました`);
        } catch (x) { err.textContent = x.message; } finally { loadBtn.disabled = false; }
      },
    }, 'GitHub から読み込む');
    wrap.append(h('div', { class: 'footer' }, loadBtn));
  }
  wrap.saveSettings = saveSettings;
  return wrap;
}

function openSaveDialog() {
  const text = output();
  const lint = runLint();
  const errs = lint.filter((x) => x.level === 'error');
  openDialog((form, close) => {
    const err = h('div', { class: 'err' });
    const changes = countChanges();
    form.append(h('h2', {}, 'キーマップを保存'));
    form.append(h('div', { class: 'note' }, changes ? `変更内容: ${changes}` : '変更はありません。'));
    if (errs.length) form.append(h('div', { class: 'err' }, `⛔ チェックでエラーが ${errs.length} 件あります。このままだとビルドが失敗する可能性があります。「コードとチェック」で確認してください。`));

    form.append(h('h3', {}, 'ファイルとして保存'), h('div', { class: 'row' },
      h('button', { onclick: (e) => { e.preventDefault(); download(text); } }, '⬇ ダウンロード'),
      h('button', { onclick: (e) => { e.preventDefault(); copyText(text); } }, '📋 コピー'),
    ));

    form.append(h('h3', {}, 'GitHub にコミット（自動でファームウェアのビルドが始まります）'));
    const gh = githubForm(err, close, 'save');
    const msgIn = h('input', { type: 'text', value: 'キーマップを更新（Zonkey キーマップ工房）' });
    const commitBtn = h('button', {
      class: 'primary', onclick: async (e) => {
        e.preventDefault(); err.textContent = '';
        const cfg = gh.saveSettings();
        if (!cfg.owner) { err.textContent = 'リポジトリを入力してください'; return; }
        if (!cfg.token) { err.textContent = '保存にはアクセストークンが必要です（下の「トークンの作り方」参照）'; return; }
        try {
          commitBtn.disabled = true;
          if (!cfg.branch) cfg.branch = await GH.getDefaultBranch(cfg);
          // 最新の sha を取得（読み込んだ元と同じファイルなら競合チェック）
          const remote = await GH.getFile(cfg);
          const sameFile = state.origin.type === 'github' && state.origin.owner === cfg.owner && state.origin.repo === cfg.repo && state.origin.path === cfg.path && state.origin.branch === cfg.branch;
          if (sameFile && state.origin.sha && remote.sha !== state.origin.sha) {
            if (!confirm('GitHub 上のファイルが、読み込んだ後に変更されています。上書きしますか？\n（キャンセルして読み込み直すのがおすすめです）')) return;
          } else if (!sameFile && !confirm(`${cfg.owner}/${cfg.repo} の ${cfg.path} を上書きします。よろしいですか？`)) return;
          const res = await GH.putFile({ ...cfg, text, sha: remote.sha, message: msgIn.value || 'Update keymap' });
          setBase(text, { type: 'github', owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, path: cfg.path, sha: res.sha }, { keepView: true });
          form.replaceChildren(
            h('h2', {}, '✅ コミットしました'),
            h('p', {}, 'GitHub Actions でファームウェアのビルドが始まります。数分後に Actions のページから「firmware」をダウンロードして、Zonkey に書き込んでください。'),
            h('div', { class: 'row' },
              h('a', { href: GH.actionsUrl(cfg), target: '_blank', rel: 'noopener' }, '▶ Actions（ビルド状況）を開く'),
              h('a', { href: res.commitUrl, target: '_blank', rel: 'noopener' }, 'コミットを見る'),
            ),
            h('div', { class: 'footer' }, h('button', { class: 'primary', onclick: close }, '閉じる')),
          );
        } catch (x) { err.textContent = x.message; } finally { commitBtn.disabled = false; }
      },
    }, '⬆ GitHub にコミット');
    form.append(gh, h('label', { class: 'field' }, h('span', {}, 'コミットメッセージ'), msgIn), err,
      h('div', { class: 'footer' }, h('button', { onclick: close }, '閉じる'), commitBtn));
  });
}

// ---------------------------------------------------------------- モード

function setMode(mode) {
  stopCapture();
  if (state.mode === 'sim' && mode !== 'sim') { releaseAllPointers(); for (const pos of pcDown.values()) sim.release(pos); pcDown.clear(); }
  state.mode = mode;
  if (mode !== 'test') state.test.on = false;
  if (mode === 'sim') state.sim.viewLayer = null;
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('boardArea').classList.toggle('hidden', false);
  renderLayerTabs();
  renderBoard();
  renderPanel();
}

// ---------------------------------------------------------------- キーボードショートカット

function inField(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

window.addEventListener('keydown', (e) => {
  if ($('dlg').open) return;
  if (state.mode === 'test' && state.test.on) { onTestKey(e); return; }
  if (state.mode === 'sim' && state.sim.pcKeys && !inField(e) && !e.ctrlKey && !e.metaKey) {
    const pos = pcPosFor(e.code);
    if (pos >= 0) {
      e.preventDefault();
      if (e.repeat || pcDown.has(e.code)) return;
      pcDown.set(e.code, pos);
      sim.press(pos);
      return;
    }
  }
  if (inField(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (state.mode !== 'edit' || state.selected == null) return;
  const pos = state.selected;
  const L = state.layers[state.current];
  if (mod && e.key.toLowerCase() === 'c') { state.clipboard = cloneB(L.bindings[pos]); toast('コピーしました'); e.preventDefault(); }
  else if (mod && e.key.toLowerCase() === 'v' && state.clipboard) { setBinding(pos, cloneB(state.clipboard)); e.preventDefault(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { setBinding(pos, TRANS()); e.preventDefault(); }
  else if (e.key === 'Escape') { state.selected = null; renderBoard(); renderEditPanel(); }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const cur = ZONKEY_LAYOUT[pos];
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    let best = null, bestScore = Infinity;
    ZONKEY_LAYOUT.forEach((k, i) => {
      if (i === pos) return;
      const dx = k.x - cur.x, dy = k.y - cur.y;
      const along = dx * dir[0] + dy * dir[1];
      if (along <= 0.2) return;
      const across = Math.abs(dx * dir[1]) + Math.abs(dy * dir[0]);
      const score = along + across * 2.5;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    if (best != null) selectKey(best);
  }
});

window.addEventListener('keyup', (e) => {
  if (state.mode === 'sim' && pcDown.has(e.code)) {
    e.preventDefault();
    const pos = pcDown.get(e.code);
    pcDown.delete(e.code);
    sim.release(pos);
  }
});
window.addEventListener('blur', () => {
  if (state.mode === 'sim') { for (const pos of pcDown.values()) sim.release(pos); pcDown.clear(); }
});

window.addEventListener('beforeunload', (e) => { if (isDirty() && state.origin.type === 'github') { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- 起動

async function init() {
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnLoad').addEventListener('click', openLoadDialog);
  $('btnSave').addEventListener('click', openSaveDialog);
  $('hostSelect').addEventListener('change', (e) => { state.host = e.target.value; sim.setHost(state.host); changed(); });
  setupBoardPointer();
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderBoard, 100); });

  const saved = store.get(STORE_KEY);
  if (saved?.baseText) {
    try {
      state.host = saved.host || 'jis';
      $('hostSelect').value = state.host;
      sim.setHost(state.host);
      setBase(saved.workText || saved.baseText, saved.origin || { type: 'paste' });
      state.baseText = saved.baseText;
      const n = state.parsed.layers.length;
      if (Array.isArray(saved.layers) && saved.layers.every((l) => l.origIndex == null || l.origIndex < n)) {
        state.layers = saved.layers.map((l) => ({ ...l, bindings: l.bindings.map(cloneB) }));
        state.current = Math.min(saved.current || 0, state.layers.length - 1);
      }
      changed();
      if (isDirty()) toast('前回の編集内容を復元しました（未保存）', 3500);
      return;
    } catch (e) { console.warn(e); }
  }
  try {
    setBase(await GH.fetchOfficial(), { type: 'official', name: '' });
    toast('Zonkey 公式のキーマップを読み込みました。「読み込み」から自分のリポジトリを開けます。', 5000);
  } catch {
    setBase(templateKeymap(), { type: 'template', name: '' });
    toast('公式キーマップを取得できなかったため、ひな形を表示しています。', 5000);
  }
}

init();

// テストやデバッグ用
window.__zonkey = { state, sim, output, setBase };
void flavorJa;
