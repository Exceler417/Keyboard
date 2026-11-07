import {
  parseKeymap, serializeKeymap, bindingToString, parseBindingString, templateKeymap, expandDefines,
} from './dts.js';
import { ZONKEY_LAYOUT, ROW_SIZES, TRACKBALL, ENCODERS, PC_KEYMAP, pcKeyLabel, positionName, layoutBounds } from './layout.js';
import { describeSensor } from './describe.js';
import { parseSensorBindings, sensorBindingsToString } from './dts.js';
import {
  KEYS, CATEGORIES, parseKeyExpr, keyLabel, charTable, keyByCode, MOD_FUNCS, MOD_USAGE_BIT, isShiftedAlias,
} from './keycodes.js';
import { describeBinding, flavorJa } from './describe.js';
import { Simulator, guessMouseLayer } from './sim.js';
import { lintKeymap } from './lint.js';
import * as GH from './github.js';
import { StudioDevice, serialSupported, bluetoothSupported, LOCKED } from './studio.js';
import { matchBehaviors, encodeBinding, decodeBinding, compareKeymaps, sameDevBinding } from './studio-map.js';
import { upsertBehavior, removeBehavior, behaviorUsages, validateBehaviorLabel, behaviorType } from './dts.js';

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
  selectedEnc: null,
  mode: 'edit',
  host: 'jis',
  history: [],
  future: [],
  clipboard: null,
  mouseLayer: null,
  sim: { pcKeys: true, latch: false, viewLayer: null },
  test: { on: false, tested: {}, last: null },
  device: { dev: null, kind: null, match: null, live: true, busy: false, compare: null, connecting: false },
};

function layerNames() {
  return state.layers.map((l, i) => l.displayName || state.parsed?.layers?.[l.origIndex]?.nodeName || `layer_${i}`);
}
function ctx() { return { parsed: state.parsed, host: state.host, layerNames: layerNames() }; }

function snapshotLayers() {
  return state.layers.map((l) => ({ ...l, bindings: l.bindings.map(cloneB) }));
}

function commit(mutator, { keepFuture = false, noPush = false } = {}) {
  const before = snapshotLayers();
  state.history.push(before);
  if (state.history.length > 200) state.history.shift();
  if (!keepFuture) state.future = [];
  mutator();
  changed();
  if (!noPush) liveSyncChanges(before);
}

function undo() {
  if (!state.history.length) return;
  const before = snapshotLayers();
  state.future.push(before);
  state.layers = state.history.pop();
  state.current = Math.min(state.current, state.layers.length - 1);
  changed();
  liveSyncChanges(before);
  toast('元に戻しました');
}
function redo() {
  if (!state.future.length) return;
  const before = snapshotLayers();
  state.history.push(before);
  state.layers = state.future.pop();
  changed();
  liveSyncChanges(before);
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
  if (state.device.dev) refreshDeviceCompare();
  renderDeviceChip();
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
  ENCODERS.forEach((enc, ei) => board.append(renderEncoderKnob(enc, ei, view, u, offY)));

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
    if (state.mode === 'device' && deviceDiffSet) {
      if (deviceDiffSet.diff.has(view + ':' + pos)) el.classList.add('diff');
      if (deviceDiffSet.err.has(view + ':' + pos)) el.classList.add('bad');
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
    edit: 'キーやエンコーダー（丸いつまみ）をクリックして編集。ドラッグで入れ替え（Alt/Ctrl を押しながらでコピー）。Delete で透過、Ctrl+C / Ctrl+V でコピー＆貼り付け。',
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
  ['Edit', 'Sim', 'Test', 'Code', 'Device'].forEach((n) => $('panel' + n).classList.toggle('hidden', state.mode !== n.toLowerCase()));
  if (state.mode === 'edit') renderEditPanel();
  else if (state.mode === 'sim') renderSimPanel();
  else if (state.mode === 'test') renderTestPanel();
  else if (state.mode === 'code') renderCodePanel();
  else if (state.mode === 'device') renderDevicePanel();
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

  if (state.selectedEnc != null) {
    renderEncoderEditor(left, right, state.selectedEnc);
  } else if (pos == null) {
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
    {
      const devMissing = (label) => state.device.dev && state.device.match && !state.device.match.byLabel.has(label);
      const sel = h('select', {
        onchange: (e) => { if (e.target.value) setBinding(pos, convertBinding(b, e.target.value)); },
      }, h('option', { value: '' }, customs.length ? '— 自作の動作から選ぶ —' : '（自作の動作はまだありません）'),
      customs.map((c) => h('option', { value: c.label, selected: b.behavior === c.label },
        `${c.displayNameProp || c.label}（${behaviorSummary(c)}）${devMissing(c.label) ? ' ※本体に未搭載' : ''}`)));
      left.append(h('h3', {}, '自作の動作'), h('div', { class: 'row' }, sel,
        h('button', { onclick: () => openBehaviorManager() }, '⚙ 作成・編集')));
      if (devMissing(b.behavior)) left.append(h('p', { class: 'warn-text' }, `「&${b.behavior}」は接続中の本体のファームウェアにまだありません。GitHub に保存してビルド・書き込みすると本体でも使えます。`));
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
  state.selectedEnc = null;
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
    ENCODERS.length ? h('div', { class: 'row', style: { marginTop: '6px' } }, 'エンコーダー:',
      h('button', { onclick: () => rotateEncoder(0, -1) }, '↺ 反時計回り'),
      h('button', { onclick: () => rotateEncoder(0, 1) }, '↻ 時計回り')) : null,
    h('p', { class: 'muted', style: { fontSize: '12px' } }, '右クリックでも、そのキーだけ押しっぱなしにできます。長押し判定は実機と同じ時間で行います。エンコーダーはつまみの上でマウスホイールを回しても試せます。'),
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

// ---------------------------------------------------------------- 本体（ZMK Studio）

let deviceDiffSet = null;

function deviceCtx() {
  const d = state.device.dev;
  return { parsed: state.parsed, match: state.device.match, layerIds: d.layerIds(), layerIndexById: d.layerIndexById() };
}

function refreshDeviceCompare() {
  const d = state.device.dev;
  if (!d || !d.keymap || !state.parsed) { state.device.compare = null; deviceDiffSet = null; return null; }
  state.device.match = matchBehaviors(d.behaviors, state.parsed);
  const cmp = compareKeymaps(state.layers, d.keymap, deviceCtx());
  state.device.compare = cmp;
  deviceDiffSet = {
    diff: new Set(cmp.diffs.map((x) => x.layer + ':' + x.pos)),
    err: new Set(cmp.errors.map((x) => x.layer + ':' + x.pos)),
  };
  return cmp;
}

function renderDeviceChip() {
  const chip = $('deviceChip');
  const d = state.device.dev;
  if (!d) { chip.classList.add('hidden'); return; }
  chip.classList.remove('hidden');
  chip.textContent = `🔗 ${d.info?.name || '本体'}${state.device.live ? '・ライブ' : ''}${d.unsaved ? '・未保存' : ''}`;
  chip.className = 'device-chip' + (d.unsaved ? ' unsaved' : '');
}

async function connectDevice(kind, makeTransport) {
  if (state.device.connecting) return;
  state.device.connecting = true;
  renderDevicePanel();
  try {
    const dev = await StudioDevice.connect(kind, {
      onNotify: async (n) => {
        if (n.core?.lockStateChanged === 1 && !dev.keymap) {
          try { await dev.loadAll(); toast('ロックが解除されました'); } catch (e) { toast(e.message); }
        }
        refreshDeviceCompare();
        renderDeviceChip();
        if (state.mode === 'device') { renderDevicePanel(); renderBoard(); }
      },
      onDisconnect: () => {
        if (state.device.dev !== dev) return;
        state.device.dev = null;
        state.device.compare = null;
        deviceDiffSet = null;
        toast('本体との接続が切れました', 3500);
        renderDeviceChip();
        if (state.mode === 'device') { renderDevicePanel(); renderBoard(); }
        if (state.mode === 'edit') renderEditPanel();
      },
    }, makeTransport);
    state.device.dev = dev;
    state.device.kind = kind;
    const cmp = refreshDeviceCompare();
    // 違いがあるときは、勝手に上書きしないようライブ反映を止めておく
    state.device.live = !!cmp && cmp.diffs.length === 0;
    toast(`${dev.info?.name || '本体'} に接続しました`);
  } catch (e) {
    if (!/cancel|キャンセル|No port selected|User cancelled/i.test(String(e?.message || e))) alert('接続できませんでした:\n' + (e?.message || e));
  } finally {
    state.device.connecting = false;
    renderDeviceChip();
    renderDevicePanel();
    renderBoard();
  }
}

async function deviceOp(label, fn) {
  if (state.device.busy) return;
  state.device.busy = true;
  renderDevicePanel();
  try {
    await fn();
  } catch (e) {
    alert(`${label}に失敗しました:\n${e.message || e}`);
  } finally {
    state.device.busy = false;
    refreshDeviceCompare();
    renderDeviceChip();
    if (state.mode === 'device') { renderDevicePanel(); renderBoard(); }
  }
}

/** アプリ → 本体（すべての違いを書き込む） */
async function writeAllToDevice() {
  const d = state.device.dev;
  await deviceOp('本体への書き込み', async () => {
    // レイヤーが足りなければ追加
    let need = state.layers.length - d.keymap.layers.length;
    if (need > 0) {
      if (d.keymap.availableLayers >= need && confirm(`本体のレイヤーが ${need} 個足りません。本体に追加しますか？`)) {
        while (need-- > 0) await d.addLayer();
      }
    }
    const cmp = refreshDeviceCompare();
    let n = 0;
    for (const x of cmp.diffs) { await d.setBinding(x.layer, x.pos, x.enc); n++; }
    for (const nd of cmp.nameDiffs) { try { await d.setLayerName(nd.layer, nd.app.slice(0, d.keymap.maxLayerNameLength || 20)); } catch { /* 名前は必須ではない */ } }
    const errs = cmp.errors.length;
    toast(`${n} キーを本体に書き込みました${errs ? `（${errs} キーは書き込めませんでした）` : ''}。「本体に保存」で確定します。`, 4500);
    state.device.live = true;
  });
}

/** 本体 → アプリ */
function importFromDevice() {
  const d = state.device.dev;
  const c = deviceCtx();
  const fails = [];
  commit(() => {
    d.keymap.layers.forEach((L, li) => {
      let target = state.layers[li];
      if (!target) {
        target = { origIndex: null, displayName: L.name || `layer ${li}`, bindings: Array.from({ length: KEY_COUNT }, TRANS), sensorBindings: null };
        state.layers.push(target);
      } else if (L.name && L.name !== target.displayName && L.name !== state.parsed.layers[target.origIndex]?.nodeName) {
        target.displayName = L.name;
      }
      L.bindings.forEach((vb, pos) => {
        if (pos >= KEY_COUNT) return;
        const cur = target.bindings[pos];
        const enc = cur ? encodeBinding(cur, c) : null;
        if (enc?.ok && sameDevBinding(enc.value, vb)) return;
        const dec = decodeBinding(vb, c);
        if (dec.ok) target.bindings[pos] = dec.value;
        else fails.push(`レイヤー${li}・${positionName(pos)}: ${dec.error}`);
      });
    });
  }, { noPush: true });
  refreshDeviceCompare();
  state.device.live = true;
  renderDevicePanel(); renderBoard();
  toast(fails.length ? `読み込みました（${fails.length} キーは変換できませんでした）` : '本体のキーマップをアプリに読み込みました。GitHub にも保存すると .keymap がそろいます。', 5000);
  if (fails.length) alert('変換できなかったキー:\n' + fails.slice(0, 20).join('\n'));
}

let livePending = [];
let liveTimer = null;
/** 編集した位置だけ本体に送る */
function liveSyncChanges(before) {
  const d = state.device.dev;
  if (!d || !d.keymap || !state.device.live) return;
  for (let li = 0; li < state.layers.length; li++) {
    const A = state.layers[li].bindings;
    const B = before[li]?.bindings || [];
    for (let pos = 0; pos < A.length; pos++) {
      if (!B[pos] || bindingToString(A[pos]) !== bindingToString(B[pos])) livePending.push([li, pos]);
    }
    if ((state.layers[li].displayName || '') !== (before[li]?.displayName || '')) livePending.push([li, 'name']);
  }
  clearTimeout(liveTimer);
  liveTimer = setTimeout(flushLive, 120);
}

async function flushLive() {
  const d = state.device.dev;
  if (!d || state.device.busy) { if (d) liveTimer = setTimeout(flushLive, 200); return; }
  const items = livePending.splice(0);
  if (!items.length) return;
  state.device.busy = true;
  const problems = [];
  let n = 0;
  try {
    const c = deviceCtx();
    for (const [li, pos] of items) {
      if (li >= d.keymap.layers.length) { problems.push(`本体にレイヤー${li} がありません`); continue; }
      if (pos === 'name') { try { await d.setLayerName(li, (state.layers[li].displayName || '').slice(0, d.keymap.maxLayerNameLength || 20)); } catch { /* ignore */ } continue; }
      const b = state.layers[li].bindings[pos];
      const enc = encodeBinding(b, c);
      if (!enc.ok) { problems.push(enc.error); continue; }
      if (sameDevBinding(enc.value, d.keymap.layers[li].bindings[pos])) continue;
      await d.setBinding(li, pos, enc.value);
      n++;
    }
  } catch (e) {
    problems.push(e.message || String(e));
  } finally {
    state.device.busy = false;
  }
  refreshDeviceCompare();
  renderDeviceChip();
  if (problems.length) toast('本体に反映できませんでした: ' + [...new Set(problems)].join(' / '), 6000);
  else if (n) toast(`本体に反映しました（${n} キー・未保存）`, 1800);
  if (state.mode === 'device') { renderDevicePanel(); renderBoard(); }
}

function renderDevicePanel() {
  const panel = $('panelDevice');
  if (state.mode !== 'device') return;
  panel.replaceChildren();
  const d = state.device.dev;
  if (!d) {
    const usb = serialSupported();
    const ble = bluetoothSupported();
    panel.append(h('div', { class: 'grid2' },
      h('div', {},
        h('h2', {}, '本体（Zonkey）に直接書き込む'),
        h('p', {}, 'ZMK Studio と同じ仕組みで、ビルドや書き込みをせずにキーマップを変更できます。'),
        h('ol', { style: { paddingLeft: '18px' } },
          h('li', {}, 'Zonkey の右手側（PC とつながる側）を USB ケーブルで PC に接続'),
          h('li', {}, '下の「USB で接続」を押して、表示された一覧から Zonkey を選ぶ'),
          h('li', {}, 'あとは「編集」画面で変更すると、すぐ本体に反映されます'),
        ),
        h('div', { class: 'row' },
          h('button', { class: 'primary', disabled: !usb || state.device.connecting, onclick: () => connectDevice('usb') }, state.device.connecting ? '接続中…' : '🔌 USB で接続'),
          h('button', { disabled: !ble || state.device.connecting, onclick: () => connectDevice('ble'), title: 'Bluetooth 接続（ファームが Bluetooth での Studio 接続に対応している場合）' }, '📶 Bluetooth で接続（試験的）'),
        ),
        !usb ? h('p', { class: 'warn-text' }, 'このブラウザは USB 接続（Web Serial）に対応していません。パソコンの Chrome か Edge で開いてください。') : null,
      ),
      h('div', {},
        h('h3', {}, '知っておくこと'),
        h('ul', { class: 'muted', style: { paddingLeft: '18px' } },
          h('li', {}, '本体への変更は「本体に保存」を押すまで仮の状態です（電源を切ると元に戻ります）。'),
          h('li', {}, '本体に保存した内容は GitHub の .keymap には入りません。両方そろえたいときは「💾 保存」で GitHub にも保存してください。'),
          h('li', {}, 'ファームウェアに入っている動作だけ使えます。新しく作った自作の動作は、GitHub に保存してビルド・書き込みした後に使えるようになります。'),
          h('li', {}, 'エンコーダー（sensor-bindings）は本体からは変更できません。'),
          h('li', {}, 'Zonkey 公式のファームは ZMK Studio 対応済み（右手側・USB）です。'),
        ),
      ),
    ));
    return;
  }

  const busy = state.device.busy;
  const head = h('div', { class: 'row' },
    h('h2', { style: { margin: 0 } }, `🔗 ${d.info?.name || '本体'} に接続中（${state.device.kind === 'ble' ? 'Bluetooth' : 'USB'}）`),
    h('span', { class: 'spacer' }),
    h('button', { onclick: () => d.disconnect() }, '切断'),
  );
  panel.append(head);

  if (d.lockState === LOCKED || !d.keymap) {
    panel.append(h('div', { class: 'desc', style: { marginTop: '10px' } }, '🔒 本体がロックされています。Zonkey に割り当てた「Studio Unlock」キーを押してください（解除されると自動で読み込みます）。'));
    return;
  }

  const cmp = state.device.compare || refreshDeviceCompare();
  const missing = [...new Set(cmp.errors.filter((e) => e.missing).map((e) => e.behavior))];
  const status = h('div', { class: 'desc', style: { marginTop: '10px' } },
    cmp.diffs.length === 0 && cmp.errors.length === 0
      ? '✅ アプリの内容と本体のキーマップは一致しています。'
      : `アプリと本体で ${cmp.diffs.length} キー違います${cmp.errors.length ? `（ほかに書き込めないキー ${cmp.errors.length}）` : ''}。`,
    cmp.layerCountApp !== cmp.layerCountDev ? h('div', {}, `レイヤー数: アプリ ${cmp.layerCountApp} / 本体 ${cmp.layerCountDev}（本体の空き ${d.keymap.availableLayers}）`) : null,
    d.unsaved ? h('div', { class: 'warn-text' }, '本体に未保存の変更があります。「本体に保存」を押すと、電源を切っても残ります。') : null,
  );
  panel.append(status);

  const liveCb = h('input', { type: 'checkbox', checked: state.device.live, onchange: (e) => { state.device.live = e.target.checked; renderDeviceChip(); } });
  panel.append(h('div', { class: 'row', style: { marginTop: '10px' } },
    h('button', { class: 'primary', disabled: busy || !cmp.diffs.length && cmp.layerCountApp <= cmp.layerCountDev, onclick: writeAllToDevice }, `⬆ アプリ → 本体に書き込む（${cmp.diffs.length}）`),
    h('button', { disabled: busy || !cmp.diffs.length && cmp.layerCountApp >= cmp.layerCountDev, onclick: () => { if (confirm('本体のキーマップでアプリの内容を置き換えますか？（元に戻すで戻せます）')) importFromDevice(); } }, '⬇ 本体 → アプリに読み込む'),
    h('button', { disabled: busy || !d.unsaved, onclick: () => deviceOp('保存', async () => { await d.save(); toast('本体に保存しました'); }) }, '💾 本体に保存'),
    h('button', { disabled: busy || !d.unsaved, onclick: () => { if (confirm('本体の未保存の変更を取り消しますか？')) deviceOp('取り消し', async () => { await d.discard(); toast('取り消しました'); }); } }, '↩ 未保存の変更を取り消す'),
  ));
  panel.append(h('label', { class: 'toggle', style: { marginTop: '8px' } }, liveCb, 'ライブ編集: 「編集」画面での変更をすぐ本体に反映する'));
  if (busy) panel.append(h('p', { class: 'muted' }, '本体と通信中…'));

  if (missing.length) {
    panel.append(h('div', { class: 'desc warn-box', style: { marginTop: '10px' } },
      h('b', {}, 'ファームウェアにまだない動作: '), missing.map((m) => '&' + m).join(', '),
      h('div', {}, 'これらは本体に書き込めません。「💾 保存」で GitHub に保存 → ビルドされたファームを書き込むと使えるようになります。'),
    ));
  }

  const grid = h('div', { class: 'grid2', style: { marginTop: '12px' } });
  const names = layerNames();
  const diffList = h('ul', { class: 'lint' });
  const showDiffs = [...cmp.errors.map((x) => ({ ...x, kind: 'err' })), ...cmp.diffs.map((x) => ({ ...x, kind: 'diff' }))].slice(0, 150);
  for (const x of showDiffs) {
    const appB = state.layers[x.layer].bindings[x.pos];
    let devText = '';
    if (x.kind === 'diff') {
      const dec = decodeBinding(x.dev, deviceCtx());
      devText = dec.ok ? describeBinding(dec.value, ctx()).tap + `（${bindingToString(dec.value)}）` : dec.error;
    }
    diffList.append(h('li', {
      class: x.kind === 'err' ? 'error' : 'warn',
      onclick: () => { state.current = x.layer; renderLayerTabs(); renderBoard(); },
      title: 'クリックでそのレイヤーを表示',
    }, `L${x.layer} ${names[x.layer]}・${positionName(x.pos)}: アプリ「${describeBinding(appB, ctx()).tap}」(${bindingToString(appB)})`,
      x.kind === 'diff' ? ` ／ 本体「${devText}」` : ` — ${x.error}`));
  }
  grid.append(h('div', {},
    h('h3', {}, '違うキー（青い枠）・書き込めないキー（赤い枠）'),
    showDiffs.length ? diffList : h('p', { class: 'muted' }, 'ありません'),
  ));

  const behList = h('ul', { class: 'log' });
  for (const b of d.behaviors) {
    const m = state.device.match.byId.get(b.id);
    behList.append(h('li', {}, `${b.displayName}`, m?.label ? h('span', { class: 'muted' }, ` → &${m.label}`) : h('span', { class: 'warn-text' }, ' （.keymap に定義なし）')));
  }
  grid.append(h('div', {},
    h('h3', {}, `本体で使える動作（${d.behaviors.length}）`),
    behList,
    h('h3', {}, '本体の設定'),
    h('div', { class: 'row' },
      h('button', { disabled: busy, onclick: () => deviceOp('再読み込み', async () => { await d.loadAll(); toast('本体から読み込み直しました'); }) }, '🔄 本体から読み直す'),
      h('button', { class: 'danger', disabled: busy, onclick: () => { if (confirm('本体で変更・保存したキーマップをすべて消して、ファームウェアのキーマップに戻しますか？')) deviceOp('初期化', async () => { await d.resetSettings(); toast('ファームウェアのキーマップに戻しました'); }); } }, '⚠ ファームの初期キーマップに戻す'),
    ),
  ));
  panel.append(grid);
}

// ---------------------------------------------------------------- 自作の動作

function behaviorSummary(c) {
  const t = behaviorType(c.compatible);
  if (t === 'mod-morph') {
    const dd = describeBinding({ behavior: c.label, params: [] }, ctx());
    return `Shift等で変化: ${dd.tap} / ${dd.shift}`;
  }
  if (t === 'hold-tap') return `タップ／長押し（${flavorJa(c.flavor || 'hold-preferred')}・${c.tappingTerm ?? 200}ms）`;
  if (t === 'macro') return `マクロ: ${c.bindings.slice(0, 6).map((b) => describeBinding(b, ctx()).tap).join(' ')}${c.bindings.length > 6 ? '…' : ''}`;
  if (/macro/.test(c.compatible)) return 'マクロ（パラメーター付き）';
  if (/sensor-rotate/.test(c.compatible)) return 'エンコーダー用';
  return c.compatible.replace('zmk,behavior-', '');
}

/** キーマップのテキストを変更（自作の動作など）して読み直す */
function applyTextChange(text) {
  const base = state.baseText;
  const sel = state.selected;
  setBase(text, state.origin, { keepView: true });
  state.baseText = base;
  state.selected = sel;
  refreshDeviceCompare();
  changed();
}

function openBehaviorManager() {
  openDialog((form, close) => {
    const list = h('div', { style: { display: 'grid', gap: '6px' } });
    const customs = Object.values(state.parsed.behaviors);
    if (!customs.length) list.append(h('p', { class: 'muted' }, 'まだ自作の動作はありません。'));
    for (const c of customs) {
      const t = behaviorType(c.compatible);
      const uses = behaviorUsages(state.parsed, state.layers, c.label);
      const devMissing = state.device.dev && state.device.match && !state.device.match.byLabel.has(c.label) && !/sensor/.test(c.compatible);
      list.append(h('div', { class: 'beh-row' },
        h('div', {},
          h('b', {}, '&' + c.label), c.displayNameProp ? ` 「${c.displayNameProp}」` : '',
          h('div', { class: 'muted', style: { fontSize: '12px' } }, behaviorSummary(c), ` ・ 使用 ${uses.length} か所`, devMissing ? ' ・ 本体に未搭載' : ''),
        ),
        h('div', { class: 'row' },
          t ? h('button', { class: 'small', onclick: (e) => { e.preventDefault(); close(); openBehaviorEditor(t, c.label); } }, '編集') : h('span', { class: 'muted', style: { fontSize: '12px' } }, 'コードで編集'),
          t ? h('button', {
            class: 'small danger', onclick: (e) => {
              e.preventDefault();
              if (uses.length) { alert(`「&${c.label}」は ${uses.length} か所で使われているため削除できません。先にそのキーを変更してください。`); return; }
              if (!confirm(`「&${c.label}」を削除しますか？`)) return;
              applyTextChange(removeBehavior(output(), c.label));
              close(); openBehaviorManager(); toast('削除しました');
            },
          }, '削除') : null,
        ),
      ));
    }
    form.append(
      h('h2', {}, '⚙ 自作の動作'),
      h('p', { class: 'muted' }, 'ここで作った動作は .keymap に追加され、どのキーにも割り当てられます（シミュレーターでも試せます）。'),
      h('div', { class: 'row' },
        h('button', { onclick: (e) => { e.preventDefault(); close(); openBehaviorEditor('mod-morph'); } }, '＋ Shift で変わるキー'),
        h('button', { onclick: (e) => { e.preventDefault(); close(); openBehaviorEditor('hold-tap'); } }, '＋ タップ／長押し'),
        h('button', { onclick: (e) => { e.preventDefault(); close(); openBehaviorEditor('macro'); } }, '＋ マクロ（連続入力）'),
      ),
      list,
      h('div', { class: 'note' }, '本体に直接書き込む場合: 新しく作った動作は、GitHub に保存してビルドしたファームを書き込むと本体でも使えるようになります。'),
      h('div', { class: 'footer' }, h('button', { onclick: close }, '閉じる')),
    );
  });
}

/** 「&kp X」形式の入力欄＋キー選択 */
function bindingField(value, onChange) {
  const wrap = h('div', { class: 'bfield' });
  let open = false;
  const draw = () => {
    wrap.replaceChildren();
    const b = parseBindingString(value) || { behavior: 'kp', params: ['A'] };
    const inp = h('input', { type: 'text', class: 'code-input', value, spellcheck: false, style: { flex: 1 } });
    inp.addEventListener('change', () => { if (parseBindingString(inp.value)) { value = inp.value.trim(); onChange(value); draw(); } else toast('「&kp A」のように入力してください'); });
    wrap.append(h('div', { class: 'row' },
      h('b', { style: { minWidth: '60px' } }, describeBinding(b, ctx()).tap), inp,
      h('button', { onclick: (e) => { e.preventDefault(); open = !open; draw(); } }, open ? '閉じる' : 'キーを選ぶ'),
    ));
    if (open) {
      wrap.append(keyPicker(b.behavior === 'kp' ? b.params[0] : 'A', (k) => { value = `&kp ${k}`; onChange(value); draw(); }));
    }
  };
  draw();
  return wrap;
}

function textToMacro(text, host) {
  const table = charTable(host);
  const out = [];
  for (const ch of text) {
    if (/[a-z]/.test(ch)) out.push('&kp ' + ch.toUpperCase());
    else if (/[A-Z]/.test(ch)) out.push(`&kp LS(${ch})`);
    else if (/[0-9]/.test(ch)) out.push('&kp N' + ch);
    else if (ch === ' ') out.push('&kp SPACE');
    else if (ch === '\n') out.push('&kp RET');
    else if (ch === '\t') out.push('&kp TAB');
    else {
      const t = table.find((c) => c.ch === ch);
      if (!t) throw new Error(`「${ch}」は入力できません（日本語などはマクロで直接入力できません）`);
      out.push('&kp ' + t.expr);
    }
  }
  return out.join(' ');
}

function openBehaviorEditor(type, label = null) {
  const existing = label ? state.parsed.behaviors[label] : null;
  const MODS = parseModMaskBits;
  const def = {
    type,
    label: label || '',
    displayName: existing?.displayNameProp || '',
  };
  if (type === 'mod-morph') {
    def.normal = existing ? bindingToString(existing.bindings[0]) : '&kp N2';
    def.morphed = existing ? bindingToString(existing.bindings[1]) : (state.host === 'jis' ? '&kp LBKT' : '&kp AT');
    def.mods = existing ? MODS(existing.mods) : 2 | 32;
    def.keepMods = existing ? MODS(existing.keepMods) : 0;
  } else if (type === 'hold-tap') {
    def.hold = existing?.bindings[0]?.behavior || 'mo';
    def.tap = existing?.bindings[1]?.behavior || 'kp';
    def.flavor = existing?.flavor || 'balanced';
    def.tappingTerm = existing?.tappingTerm ?? 200;
    def.quickTap = existing?.quickTap ?? 0;
  } else {
    def.bindings = existing ? existing.bindings.map(bindingToString).join(' ') : '&kp H &kp E &kp L &kp L &kp O';
    def.waitMs = existing?.waitMs ?? 30;
    def.tapMs = existing?.tapMs ?? 30;
  }
  const canAssign = !label && state.selected != null;
  const title = { 'mod-morph': 'Shift で変わるキー（mod-morph）', 'hold-tap': 'タップ／長押し（hold-tap）', macro: 'マクロ（macro）' }[type];

  openDialog((form, close) => {
    const err = h('div', { class: 'err' });
    const labelIn = h('input', { type: 'text', value: def.label, placeholder: '例: my_key', disabled: !!label, spellcheck: false });
    const dnIn = h('input', { type: 'text', value: def.displayName, placeholder: '例: 2 / @（ZMK Studio などで表示される名前）' });
    const body = h('div', { style: { display: 'grid', gap: '10px' } });
    const modBoxes = (bits, onChange) => h('div', { class: 'mods' }, [['Shift', 2 | 32], ['Ctrl', 1 | 16], ['Alt', 4 | 64], ['Win/Cmd', 8 | 128]].map(([n, m]) => {
      const cb = h('input', { type: 'checkbox', checked: (bits & m) !== 0 });
      cb.addEventListener('change', () => { bits = cb.checked ? bits | m : bits & ~m; onChange(bits); });
      return h('label', {}, cb, n);
    }));

    if (type === 'mod-morph') {
      body.append(
        h('div', { class: 'field' }, h('span', { class: 'muted' }, 'ふつうに押したとき'), bindingField(def.normal, (v) => { def.normal = v; })),
        h('div', { class: 'field' }, h('span', { class: 'muted' }, '一緒に押すと変化する修飾キー'), modBoxes(def.mods, (v) => { def.mods = v; })),
        h('div', { class: 'field' }, h('span', { class: 'muted' }, '修飾キーと一緒に押したとき'), bindingField(def.morphed, (v) => { def.morphed = v; })),
        h('label', { class: 'toggle' }, (() => { const cb = h('input', { type: 'checkbox', checked: !!def.keepMods }); cb.addEventListener('change', () => { def.keepMods = cb.checked ? def.mods : 0; }); return cb; })(),
          '変化後も修飾キーを押したままにする（keep-mods。例: Shift+BS → Shift+Delete）'),
        h('div', { class: 'note' }, '例: ふつうは「2」、Shift と一緒なら「@」。JIS の PC で記号の位置を US 配列風にしたいときなどに便利です。'),
      );
    } else if (type === 'hold-tap') {
      const holdSel = h('select', { onchange: (e) => { def.hold = e.target.value; } },
        h('option', { value: 'mo', selected: def.hold === 'mo' }, 'レイヤー（押している間）&mo'),
        h('option', { value: 'kp', selected: def.hold === 'kp' }, 'キー・修飾キー &kp'),
        h('option', { value: 'sl', selected: def.hold === 'sl' }, 'ワンショットレイヤー &sl'),
        h('option', { value: 'tog', selected: def.hold === 'tog' }, 'レイヤー固定 &tog'));
      const tapSel = h('select', { onchange: (e) => { def.tap = e.target.value; } },
        h('option', { value: 'kp', selected: def.tap === 'kp' }, 'キー &kp'),
        h('option', { value: 'mo', selected: def.tap === 'mo' }, 'レイヤー &mo'),
        h('option', { value: 'tog', selected: def.tap === 'tog' }, 'レイヤー固定 &tog'));
      const flavorSel = h('select', { onchange: (e) => { def.flavor = e.target.value; } },
        [['balanced', 'バランス（他のキーを押して離したら長押し）'], ['hold-preferred', '長押し優先（他のキーを押したらすぐ長押し）'], ['tap-preferred', 'タップ優先（時間だけで判定）'], ['tap-unless-interrupted', '割り込みで長押し（時間が過ぎてもタップ）']]
          .map(([v, l]) => h('option', { value: v, selected: def.flavor === v }, l)));
      const tt = h('input', { type: 'number', min: 50, max: 2000, step: 10, value: def.tappingTerm });
      tt.addEventListener('change', () => { def.tappingTerm = tt.value; });
      const qt = h('input', { type: 'number', min: 0, max: 2000, step: 10, value: def.quickTap });
      qt.addEventListener('change', () => { def.quickTap = qt.value; });
      body.append(
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, h('span', { class: 'muted' }, '長押ししたとき'), holdSel),
          h('label', { class: 'field' }, h('span', { class: 'muted' }, 'タップしたとき'), tapSel)),
        h('label', { class: 'field' }, h('span', { class: 'muted' }, '判定の方式（flavor）'), flavorSel),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, h('span', { class: 'muted' }, '長押しと判定する時間（ms）'), tt),
          h('label', { class: 'field' }, h('span', { class: 'muted' }, 'クイックタップ（ms・0 で無効）'), qt)),
        h('div', { class: 'note' }, '割り当てたキーで「長押しのレイヤー／キー」と「タップのキー」を指定します。lt / mt の判定時間や方式を変えた版を作りたいときに使います。'),
      );
    } else {
      const ta = h('textarea', { class: 'code', style: { minHeight: '90px' }, spellcheck: false });
      ta.value = def.bindings;
      ta.addEventListener('change', () => { def.bindings = ta.value; });
      const textIn = h('input', { type: 'text', placeholder: '例: hello@example.com', style: { flex: 1 } });
      const wait = h('input', { type: 'number', min: 0, max: 1000, value: def.waitMs });
      wait.addEventListener('change', () => { def.waitMs = wait.value; });
      const tap = h('input', { type: 'number', min: 0, max: 1000, value: def.tapMs });
      tap.addEventListener('change', () => { def.tapMs = tap.value; });
      body.append(
        h('div', { class: 'field' }, h('span', { class: 'muted' }, '文字列から作る（英数字・記号）'),
          h('div', { class: 'row' }, textIn, h('button', {
            onclick: (e) => {
              e.preventDefault();
              try { ta.value = textToMacro(textIn.value, state.host); def.bindings = ta.value; err.textContent = ''; } catch (x) { err.textContent = x.message; }
            },
          }, '変換'))),
        h('div', { class: 'field' }, h('span', { class: 'muted' }, '送るキー（順番に押されます）'), ta),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, h('span', { class: 'muted' }, 'キーの間隔（wait-ms）'), wait),
          h('label', { class: 'field' }, h('span', { class: 'muted' }, '押している時間（tap-ms）'), tap)),
        h('div', { class: 'note' }, 'ショートカットの組み合わせ（例: &kp LC(C) &kp LC(V)）も書けます。'),
      );
    }

    const assignCb = h('input', { type: 'checkbox', checked: canAssign });
    form.append(
      h('h2', {}, (label ? '編集: ' : '新規: ') + title),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', {}, '名前（キーマップで &名前 として使う）'), labelIn),
        h('label', { class: 'field' }, h('span', {}, '表示名（任意）'), dnIn)),
      body,
      canAssign ? h('label', { class: 'toggle' }, assignCb, `選択中のキー（レイヤー${state.current}・${positionName(state.selected)}）に割り当てる`) : null,
      err,
      h('div', { class: 'footer' },
        h('button', { onclick: (e) => { e.preventDefault(); close(); openBehaviorManager(); } }, '戻る'),
        h('button', {
          class: 'primary', onclick: (e) => {
            e.preventDefault();
            def.label = labelIn.value.trim();
            def.displayName = dnIn.value.trim();
            const v = validateBehaviorLabel(def.label, state.parsed, label);
            if (v) { err.textContent = v; return; }
            if (type === 'mod-morph') {
              if (!parseBindingString(def.normal) || !parseBindingString(def.morphed)) { err.textContent = 'キーを正しく指定してください'; return; }
              if (!def.mods) { err.textContent = '変化させる修飾キーを 1 つ以上選んでください'; return; }
              if (def.keepMods) def.keepMods = def.mods;
            }
            if (type === 'macro' && !/&\w+/.test(def.bindings || '')) { err.textContent = '送るキーを入力してください'; return; }
            try {
              const text = upsertBehavior(output(), def);
              const pos = state.selected;
              const assign = canAssign && assignCb.checked;
              applyTextChange(text);
              if (assign) {
                const params = type === 'hold-tap' ? [def.hold === 'kp' ? 'LSHIFT' : '1', def.tap === 'kp' ? 'A' : '1'] : [];
                setBinding(pos, { behavior: def.label, params });
              }
              close();
              toast(`「&${def.label}」を${label ? '更新' : '作成'}しました${state.device.dev ? '。本体で使うには GitHub に保存してビルド・書き込みが必要です' : ''}`, 4500);
            } catch (x) { err.textContent = x.message; }
          },
        }, label ? '更新' : '作成'),
      ),
    );
  });
}

function parseModMaskBits(str) {
  if (!str) return 0;
  const map = { MOD_LCTL: 1, MOD_LSFT: 2, MOD_LALT: 4, MOD_LGUI: 8, MOD_RCTL: 16, MOD_RSFT: 32, MOD_RALT: 64, MOD_RGUI: 128 };
  let m = 0;
  for (const id of String(str).match(/MOD_[A-Z]+/g) || []) m |= map[id] || 0;
  return m;
}

// ---------------------------------------------------------------- エンコーダー

function sensorList(layerIdx) {
  return parseSensorBindings(state.layers[layerIdx]?.sensorBindings);
}

/** 透過を解決して、そのレイヤーで実際に使われるエンコーダーの設定 */
function effectiveSensor(layerIdx, ei) {
  for (let l = layerIdx; l >= 0; l--) {
    const b = sensorList(l)[ei];
    if (b && b.behavior !== 'trans' && b.behavior !== 'none') return { binding: b, layer: l };
  }
  return { binding: null, layer: 0 };
}

function shortLabel(s) {
  const t = String(s || '').replace('スクロール', '🖱');
  return [...t].length > 6 ? [...t].slice(0, 6).join('') + '…' : t;
}

function renderEncoderKnob(enc, ei, view, u, offY) {
  const own = sensorList(view)[ei];
  let shown = own;
  let from = view;
  if (state.mode === 'sim' && state.sim.viewLayer == null) {
    const act = sim.activeLayers();
    shown = null;
    for (let i = act.length - 1; i >= 0; i--) {
      const b = sensorList(act[i])[ei];
      if (b && b.behavior !== 'trans' && b.behavior !== 'none') { shown = b; from = act[i]; break; }
    }
  } else if (!own || own.behavior === 'trans' || own.behavior === 'none') {
    const eff = effectiveSensor(view - 1, ei);
    shown = eff.binding;
    from = eff.layer;
  }
  const d = describeSensor(shown, ctx());
  const isTrans = state.mode !== 'sim' && (!own || own.behavior === 'trans') && view > 0;
  const knob = h('div', {
    class: 'encoder' + (state.selectedEnc === ei && state.mode === 'edit' ? ' selected' : '') + (isTrans ? ' trans' : ''),
    style: {
      left: (enc.cx - enc.r) * u + 'px', top: (enc.cy - enc.r - offY) * u + 'px',
      width: enc.r * 2 * u + 'px', height: enc.r * 2 * u + 'px',
    },
    title: `${enc.name}\n時計回り: ${d.cw.desc || d.cw.tap}\n反時計回り: ${d.ccw.desc || d.ccw.tap}${isTrans ? `\n（L${from} と同じ）` : ''}`
      + (state.mode === 'sim' ? '\nクリック: 時計回り / 右クリック: 反時計回り / ホイールでも回せます' : state.mode === 'edit' ? '\nクリックで編集' : ''),
  },
  h('span', { class: 'enc-cw' }, '↻' + shortLabel(d.cw.tap)),
  h('span', { class: 'enc-ccw' }, '↺' + shortLabel(d.ccw.tap)));
  knob.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    if (state.mode === 'edit') {
      state.selectedEnc = ei;
      state.selected = null;
      renderBoard();
      renderEditPanel();
    } else if (state.mode === 'sim') {
      e.preventDefault();
      rotateEncoder(ei, e.button === 2 ? -1 : 1);
    }
  });
  knob.addEventListener('contextmenu', (e) => e.preventDefault());
  knob.addEventListener('wheel', (e) => {
    if (state.mode !== 'sim') return;
    e.preventDefault();
    rotateEncoder(ei, e.deltaY > 0 ? 1 : -1);
  }, { passive: false });
  return knob;
}

function rotateEncoder(ei, dir) {
  sim.rotate(ei, dir, state.layers.map((l) => parseSensorBindings(l.sensorBindings)));
}

/** エンコーダー ei の設定を変える（layers: 対象レイヤー番号の配列） */
function setSensor(ei, binding, layers = [state.current]) {
  commit(() => {
    for (const li of layers) {
      const list = sensorList(li);
      while (list.length < ei) list.push({ behavior: 'trans', params: [] });
      list[ei] = binding;
      // 末尾の未設定を詰める
      state.layers[li].sensorBindings = sensorBindingsToString(list);
    }
  }, { noPush: true });
}

/** 時計回り / 反時計回りの binding を持つ sensor-rotate 動作を探す（なければ作る） */
function ensureRotateBehavior(cw, ccw, baseName) {
  const found = Object.values(state.parsed.behaviors).find((c) => c.compatible === 'zmk,behavior-sensor-rotate'
    && c.bindings.length >= 2 && bindingToString(c.bindings[0]) === cw && bindingToString(c.bindings[1]) === ccw);
  if (found) return found.label;
  let label = baseName;
  let n = 2;
  while (state.parsed.behaviors[label] || validateBehaviorLabel(label, state.parsed)) label = `${baseName}${n++}`;
  applyTextChange(upsertBehavior(output(), { type: 'sensor-rotate', label, cw, ccw, tapMs: 20 }));
  return label;
}

function encoderPresets() {
  const jis = state.host === 'jis';
  return [
    { id: 'scroll_v', name: 'スクロール（上下）', rotate: ['&msc SCRL_DOWN', '&msc SCRL_UP'], base: 'enc_scroll_v' },
    { id: 'scroll_h', name: 'スクロール（左右）', rotate: ['&msc SCRL_RIGHT', '&msc SCRL_LEFT'], base: 'enc_scroll_h' },
    { id: 'vol', name: '音量', keys: ['C_VOL_UP', 'C_VOL_DN'] },
    { id: 'arrow_v', name: '矢印（上下）', keys: ['DOWN', 'UP'] },
    { id: 'arrow_h', name: '矢印（左右）', keys: ['RIGHT', 'LEFT'] },
    { id: 'page', name: 'ページ送り', keys: ['PG_DN', 'PG_UP'] },
    { id: 'tab', name: 'タブ切り替え', keys: ['LC(TAB)', 'LC(LS(TAB))'] },
    { id: 'zoom', name: 'ズーム', keys: [jis ? 'LC(SEMI)' : 'LC(EQUAL)', 'LC(MINUS)'] },
    { id: 'undo', name: 'やり直し / 元に戻す', keys: ['LC(Y)', 'LC(Z)'] },
    { id: 'bright', name: '画面の明るさ', keys: ['C_BRI_UP', 'C_BRI_DN'] },
    { id: 'media', name: '曲送り / 曲戻し', keys: ['C_NEXT', 'C_PREV'] },
  ];
}

function presetBinding(p) {
  if (p.keys) return { behavior: 'inc_dec_kp', params: [...p.keys] };
  return null;
}

function bindingMatchesPreset(b, p) {
  if (!b) return false;
  if (p.keys) return b.behavior === 'inc_dec_kp' && b.params[0] === p.keys[0] && b.params[1] === p.keys[1];
  const c = state.parsed.behaviors[b.behavior];
  return !!c && c.compatible === 'zmk,behavior-sensor-rotate' && c.bindings.length >= 2
    && bindingToString(c.bindings[0]) === p.rotate[0] && bindingToString(c.bindings[1]) === p.rotate[1];
}

function renderEncoderEditor(left, right, ei) {
  const enc = ENCODERS[ei];
  const L = state.current;
  const own = sensorList(L)[ei] || null;
  const eff = (!own || own.behavior === 'trans') && L > 0 ? effectiveSensor(L - 1, ei) : { binding: own, layer: L };
  const d = describeSensor(own, ctx());
  const de = describeSensor(eff.binding, ctx());
  const allLayers = state.layers.map((_, i) => i);

  const apply = (b) => setSensor(ei, b);
  const applyPreset = (p, layers = [L]) => {
    if (p.keys) { setSensor(ei, presetBinding(p), layers); return; }
    const label = ensureRotateBehavior(p.rotate[0], p.rotate[1], p.base);
    setSensor(ei, { behavior: label, params: [] }, layers);
  };

  left.append(
    h('h2', {}, `🎛 ${enc.name} ・ レイヤー${L}`),
    h('div', { class: 'desc' },
      h('div', {}, '↻ 時計回り: ', h('b', {}, de.cw.desc || de.cw.tap)),
      h('div', {}, '↺ 反時計回り: ', h('b', {}, de.ccw.desc || de.ccw.tap)),
      (!own || own.behavior === 'trans') && L > 0 ? h('div', { class: 'muted' }, `このレイヤーは透過なので、レイヤー${eff.layer} の設定が使われます。`) : null,
      d.kind === 'unknown' ? h('div', { class: 'warn-text' }, '「コード」欄で直接設定された動作です。') : null,
    ),
  );

  const codeIn = h('input', { type: 'text', class: 'code-input', value: own ? bindingToString(own) : '', placeholder: '例: &inc_dec_kp C_VOL_UP C_VOL_DN', spellcheck: false });
  const applyCode = () => {
    const v = codeIn.value.trim();
    if (!v) { apply(null); return; }
    const b = parseBindingString(v);
    if (!b) { toast('「&」で始まる ZMK のコードを入力してください'); return; }
    apply(b);
  };
  codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCode(); });
  left.append(h('h3', {}, 'ZMK のコード（直接編集もできます）'), h('div', { class: 'row' }, codeIn, h('button', { onclick: applyCode }, '適用')));

  const presets = encoderPresets();
  const grid = h('div', { class: 'behaviors' });
  for (const p of presets) {
    grid.append(h('button', { class: bindingMatchesPreset(own, p) ? 'active' : '', onclick: () => applyPreset(p) }, p.name));
  }
  grid.append(
    h('button', { class: own?.behavior === 'trans' ? 'active' : '', disabled: L === 0, title: L === 0 ? 'レイヤー0 では使えません' : '', onclick: () => apply({ behavior: 'trans', params: [] }) }, '透過 ▽'),
  );
  left.append(h('h3', {}, 'よく使う設定'), grid);

  const canSwap = own && (own.behavior === 'inc_dec_kp' || state.parsed.behaviors[own.behavior]?.compatible === 'zmk,behavior-sensor-rotate');
  left.append(h('div', { class: 'row', style: { marginTop: '12px' } },
    h('button', {
      disabled: !canSwap, title: '時計回りと反時計回りを入れ替えます',
      onclick: () => {
        if (own.behavior === 'inc_dec_kp') { apply({ behavior: 'inc_dec_kp', params: [own.params[1], own.params[0]] }); return; }
        const c = state.parsed.behaviors[own.behavior];
        const label = ensureRotateBehavior(bindingToString(c.bindings[1]), bindingToString(c.bindings[0]), `${own.behavior}_rev`.slice(0, 20));
        setSensor(ei, { behavior: label, params: [] });
      },
    }, '⇄ 回す向きを逆にする'),
    h('button', {
      disabled: !own, onclick: () => {
        if (!confirm(`すべてのレイヤーのエンコーダーを「${bindingToString(own)}」にしますか？`)) return;
        setSensor(ei, own, allLayers);
        toast('すべてのレイヤーに設定しました');
      },
    }, '全レイヤーに同じ設定'),
  ));

  left.append(h('div', { class: 'note', style: { marginTop: '12px', fontSize: '12px' } },
    'エンコーダーの設定は「本体に接続」（ZMK Studio）では書き込めません。「💾 保存」で GitHub に保存し、ビルドされたファームを右手側に書き込むと反映されます（キーマップは右手側に入っています）。',
    ' 回す向きが逆に感じたら「回す向きを逆にする」を押してください。'));

  // 自分で選ぶ（時計回り / 反時計回り）
  const cwKey = own?.behavior === 'inc_dec_kp' ? own.params[0] : null;
  const ccwKey = own?.behavior === 'inc_dec_kp' ? own.params[1] : null;
  right.append(
    h('h2', {}, '自分でキーを選ぶ'),
    h('p', { class: 'muted', style: { fontSize: '12px' } }, '回すたびに、選んだキーが 1 回押されます（&inc_dec_kp）。'),
    h('h3', {}, '↻ 時計回りに回したとき'),
    own?.behavior !== 'inc_dec_kp' ? h('p', { class: 'muted', style: { fontSize: '12px' } }, '今はキー以外の設定です。ここで選ぶとキー入力に切り替わります。') : null,
    keyPicker(cwKey || '', (k) => apply({ behavior: 'inc_dec_kp', params: [k, ccwKey || 'C_VOL_DN'] })),
    h('h3', {}, '↺ 反時計回りに回したとき'),
    keyPicker(ccwKey || '', (k) => apply({ behavior: 'inc_dec_kp', params: [cwKey || 'C_VOL_UP', k] })),
  );
}

// ---------------------------------------------------------------- モード

function setMode(mode) {
  stopCapture();
  if (state.mode === 'sim' && mode !== 'sim') { releaseAllPointers(); for (const pos of pcDown.values()) sim.release(pos); pcDown.clear(); }
  state.mode = mode;
  if (mode !== 'test') state.test.on = false;
  if (mode === 'device') refreshDeviceCompare();
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
  else if (e.key === 'Escape') { state.selected = null; state.selectedEnc = null; renderBoard(); renderEditPanel(); }
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

window.addEventListener('beforeunload', (e) => {
  if ((isDirty() && state.origin.type === 'github') || state.device.dev?.unsaved) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- 起動

async function init() {
  document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  $('btnUndo').addEventListener('click', undo);
  $('btnRedo').addEventListener('click', redo);
  $('btnLoad').addEventListener('click', openLoadDialog);
  $('btnSave').addEventListener('click', openSaveDialog);
  $('deviceChip').addEventListener('click', () => setMode('device'));
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
window.__zonkey = { state, sim, output, setBase, connectDevice };
void flavorJa;
