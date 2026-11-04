// アプリの binding（{behavior:'kp', params:['A']}）と、ZMK Studio の本体側表現
// （{behaviorId, param1, param2}）を相互に変換する。本体との通信はしない純粋な関数だけ。

import { expandDefines, holdTapConfig } from './dts.js';
import { parseKeyExpr, keyByUsage } from './keycodes.js';

const CONSUMER = 0x10000;

// ZMK 組み込み behavior の display-name → .keymap でのラベル
export const BUILTIN_BY_DISPLAY = {
  'Key Press': 'kp', 'Key Toggle': 'kt', 'Key Repeat': 'key_repeat',
  'Layer-Tap': 'lt', 'Mod-Tap': 'mt', 'Momentary Layer': 'mo', 'Toggle Layer': 'tog', 'To Layer': 'to',
  'Sticky Key': 'sk', 'Sticky Layer': 'sl', 'Transparent': 'trans', 'None': 'none',
  'Bluetooth': 'bt', 'Output Selection': 'out', 'Mouse Key Press': 'mkp', 'Caps Word': 'caps_word',
  'Bootloader': 'bootloader', 'Reset': 'sys_reset', 'Studio Unlock': 'studio_unlock',
  'Grave/Escape': 'gresc', 'Underglow': 'rgb_ug', 'Backlight': 'bl', 'External Power': 'ext_power',
  'Soft Off': 'soft_off', 'Mouse Move': 'mmv', 'Mouse Scroll': 'msc',
};

const BUILTIN_CELLS = {
  kp: 1, kt: 1, lt: 2, mt: 2, mo: 1, to: 1, tog: 1, sl: 1, sk: 1, trans: 0, none: 0,
  bt: 2, out: 1, mkp: 1, caps_word: 0, key_repeat: 0, bootloader: 0, sys_reset: 0, studio_unlock: 0,
  gresc: 0, rgb_ug: 2, bl: 2, ext_power: 1, soft_off: 0, msc: 1, mmv: 1,
};

const LAYER_FIRST = new Set(['mo', 'to', 'tog', 'sl', 'lt']);
const KEY_PARAMS = { kp: [0], kt: [0], sk: [0], lt: [1], mt: [0, 1], gresc: [] };

const BT_NAMES = { 0: 'BT_CLR', 1: 'BT_NXT', 2: 'BT_PRV', 3: 'BT_SEL', 4: 'BT_CLR_ALL', 5: 'BT_DISC' };
const OUT_NAMES = { 0: 'OUT_TOG', 1: 'OUT_USB', 2: 'OUT_BLE', 3: 'OUT_NONE' };
const MB_NAMES = { 1: 'MB1', 2: 'MB2', 4: 'MB3', 8: 'MB4', 16: 'MB5' };

function constants(defines) {
  const scrl = parseInt(expandDefines('ZMK_POINTING_DEFAULT_SCRL_VAL', defines)) || 10;
  const move = parseInt(expandDefines('ZMK_POINTING_DEFAULT_MOVE_VAL', defines)) || 600;
  const y = (v) => String(v & 0xffff);
  const x = (v) => String(((v & 0xffff) << 16) >>> 0);
  return {
    BT_CLR: '0 0', BT_NXT: '1 0', BT_PRV: '2 0', BT_SEL: '3', BT_CLR_ALL: '4 0', BT_DISC: '5',
    OUT_TOG: '0', OUT_USB: '1', OUT_BLE: '2', OUT_NONE: '3',
    MB1: '1', MB2: '2', MB3: '4', MB4: '8', MB5: '16', LCLK: '1', RCLK: '2', MCLK: '4',
    SCRL_UP: y(scrl), SCRL_DOWN: y(-scrl), SCRL_LEFT: x(-scrl), SCRL_RIGHT: x(scrl),
    MOVE_UP: y(-move), MOVE_DOWN: y(move), MOVE_LEFT: x(-move), MOVE_RIGHT: x(move),
  };
}

/** キー式 → ZMK のエンコード値（(mods<<24) | (page<<16) | id） */
export function encodeKey(expr, defines) {
  const p = parseKeyExpr(expandDefines(String(expr ?? ''), defines));
  if (!p) return null;
  const consumer = p.usage >= CONSUMER;
  const id = consumer ? p.usage - CONSUMER : p.usage;
  return (((p.mods & 0xff) << 24) | ((consumer ? 0x0c : 0x07) << 16) | id) >>> 0;
}

const MOD_FN = [['LC', 1], ['LS', 2], ['LA', 4], ['LG', 8], ['RC', 16], ['RS', 32], ['RA', 64], ['RG', 128]];

/** ZMK のエンコード値 → キー式 */
export function decodeKey(v) {
  v >>>= 0;
  const mods = v >>> 24;
  const page = (v >>> 16) & 0xff;
  const id = v & 0xffff;
  const key = page === 0x0c ? keyByUsage(CONSUMER + id) : keyByUsage(id);
  let s = key ? key.name : '0x' + id.toString(16);
  for (let i = MOD_FN.length - 1; i >= 0; i--) if (mods & MOD_FN[i][1]) s = `${MOD_FN[i][0]}(${s})`;
  return s;
}

/** パラメーターの数値（BIT(n) や 0x.. も） */
function evalNumber(tok) {
  const t = String(tok).replace(/\s+/g, '');
  let m = /^BIT\((\d+)\)$/.exec(t);
  if (m) return (1 << parseInt(m[1])) >>> 0;
  if (/^-?(0x[0-9a-f]+|\d+)$/i.test(t)) return parseInt(t) >>> 0;
  m = /^\((.*)\)$/.exec(t);
  if (m) return evalNumber(m[1]);
  return null;
}

/** 括弧を考慮して空白で分割 */
function tokenize(s) {
  const out = [];
  let cur = '', depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; continue; }
    if (/\s/.test(ch)) continue;
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 本体の behavior 一覧と .keymap の behavior を対応づける。
 * devBehaviors: [{ id, displayName, metadata }]
 */
export function matchBehaviors(devBehaviors, parsed) {
  const byLabel = new Map();
  const byId = new Map();
  const customs = Object.values(parsed?.behaviors || {});
  for (const d of devBehaviors) {
    let label = BUILTIN_BY_DISPLAY[d.displayName] || null;
    if (!label) {
      const c = customs.find((b) => [b.displayNameProp, b.labelProp, b.nodeName, b.label].includes(d.displayName));
      if (c) label = c.label;
    }
    const entry = { ...d, label };
    byId.set(d.id, entry);
    if (label && !byLabel.has(label)) byLabel.set(label, entry);
  }
  return { byLabel, byId };
}

/** そのパラメーター位置がレイヤー番号か */
function isLayerParam(label, slot, parsed, dev) {
  if (slot === 0 && LAYER_FIRST.has(label)) return true;
  const c = parsed?.behaviors?.[label];
  if (c && c.compatible === 'zmk,behavior-hold-tap') {
    const child = c.bindings[slot]?.behavior;
    if (['mo', 'to', 'tog', 'sl'].includes(child)) return true;
  }
  const meta = dev?.metadata || [];
  const key = slot === 0 ? 'param1' : 'param2';
  return meta.length > 0 && meta.every((set) => (set[key] || []).length > 0 && set[key].some((v) => v.layerId));
}

function isKeyParam(label, slot, parsed, dev) {
  if (KEY_PARAMS[label]) return KEY_PARAMS[label].includes(slot);
  const c = parsed?.behaviors?.[label];
  if (c && c.compatible === 'zmk,behavior-hold-tap') {
    const child = c.bindings[slot]?.behavior;
    if (child === 'kp' || child === 'kt' || child === 'sk') return true;
  }
  const meta = dev?.metadata || [];
  const key = slot === 0 ? 'param1' : 'param2';
  return meta.some((set) => (set[key] || []).some((v) => v.hidUsage));
}

function cellsFor(label, parsed, dev) {
  const c = parsed?.behaviors?.[label];
  if (c) return c.bindingCells || 0;
  if (label in BUILTIN_CELLS) return BUILTIN_CELLS[label];
  const meta = dev?.metadata || [];
  if (meta.some((s) => (s.param2 || []).some((v) => !v.nil))) return 2;
  if (meta.some((s) => (s.param1 || []).some((v) => !v.nil))) return 1;
  return 0;
}

/**
 * アプリの binding → 本体の binding
 * ctx: { parsed, match, layerIds: [index → id] }
 * 戻り値: { ok: true, value: {behaviorId, param1, param2} } | { ok: false, error }
 */
export function encodeBinding(b, ctx) {
  const dev = ctx.match.byLabel.get(b.behavior);
  if (!dev) {
    const custom = ctx.parsed?.behaviors?.[b.behavior];
    return {
      ok: false, missing: true,
      error: custom
        ? `本体のファームウェアに「&${b.behavior}」がありません。GitHub に保存してビルドし、書き込むと使えるようになります。`
        : `本体のファームウェアに「&${b.behavior}」がありません。`,
    };
  }
  const defines = ctx.parsed?.defines;
  const consts = constants(defines);
  let joined = b.params.map((p) => expandDefines(p, defines)).join(' ');
  joined = joined.replace(/[A-Z_][A-Z0-9_]*/g, (id) => (id in consts ? consts[id] : id));
  const toks = tokenize(joined);
  const vals = [0, 0];
  for (let slot = 0; slot < Math.min(2, toks.length); slot++) {
    const t = toks[slot];
    if (isLayerParam(b.behavior, slot, ctx.parsed, dev)) {
      const idx = evalNumber(t);
      if (idx == null) return { ok: false, error: `レイヤー番号「${t}」を解釈できません。` };
      const id = ctx.layerIds[idx];
      if (id == null) return { ok: false, error: `本体にレイヤー${idx} がありません。` };
      vals[slot] = id;
      continue;
    }
    const n = evalNumber(t);
    if (n != null && !isKeyParam(b.behavior, slot, ctx.parsed, dev)) { vals[slot] = n; continue; }
    const k = encodeKey(t, defines);
    if (k != null) { vals[slot] = k; continue; }
    if (n != null) { vals[slot] = n; continue; }
    return { ok: false, error: `パラメーター「${t}」を本体用の値に変換できません。` };
  }
  return { ok: true, value: { behaviorId: dev.id, param1: vals[0] >>> 0, param2: vals[1] >>> 0 } };
}

/**
 * 本体の binding → アプリの binding
 * ctx: { parsed, match, layerIndexById: Map(id → index) }
 */
export function decodeBinding(v, ctx) {
  const dev = ctx.match.byId.get(v.behaviorId);
  if (!dev) return { ok: false, error: `不明な動作 ID ${v.behaviorId}` };
  if (!dev.label) return { ok: false, error: `本体の動作「${dev.displayName}」は .keymap に定義がありません。` };
  const label = dev.label;
  const p = [v.param1 >>> 0, v.param2 >>> 0];
  const params = [];
  if (label === 'bt') {
    params.push(BT_NAMES[p[0]] || String(p[0]));
    if (p[0] === 3 || p[0] === 5) params.push(String(p[1]));
    return { ok: true, value: { behavior: label, params } };
  }
  if (label === 'out') return { ok: true, value: { behavior: label, params: [OUT_NAMES[p[0]] || String(p[0])] } };
  if (label === 'mkp') return { ok: true, value: { behavior: label, params: [MB_NAMES[p[0]] || String(p[0])] } };
  const cells = cellsFor(label, ctx.parsed, dev);
  for (let slot = 0; slot < cells; slot++) {
    if (isLayerParam(label, slot, ctx.parsed, dev)) {
      const idx = ctx.layerIndexById.get(p[slot]);
      params.push(String(idx ?? p[slot]));
    } else if (isKeyParam(label, slot, ctx.parsed, dev)) {
      params.push(decodeKey(p[slot]));
    } else {
      params.push(String(p[slot]));
    }
  }
  return { ok: true, value: { behavior: label, params } };
}

// &kp 0x89 のようにページ 0 で書かれたキーは、本体ではキーボードページ（7）と同じ扱い
function normalize(v, ctx) {
  if (!v) return v;
  const dev = ctx.match.byId.get(v.behaviorId);
  if (!dev?.label) return v;
  const out = { ...v };
  ['param1', 'param2'].forEach((k, slot) => {
    if (isKeyParam(dev.label, slot, ctx.parsed, dev) && ((out[k] >>> 16) & 0xff) === 0) out[k] = (out[k] | (0x07 << 16)) >>> 0;
  });
  return out;
}

export function sameDevBinding(a, b) {
  return a && b && a.behaviorId === b.behaviorId && (a.param1 >>> 0) === (b.param1 >>> 0) && (a.param2 >>> 0) === (b.param2 >>> 0);
}

/**
 * アプリのレイヤーと本体のキーマップを比べる
 * 戻り値: { diffs: [{layer, pos, app, dev, enc}], errors: [{layer,pos,error,missing}], layerCountApp, layerCountDev, nameDiffs }
 */
export function compareKeymaps(appLayers, devKeymap, ctx) {
  const diffs = [];
  const errors = [];
  const nameDiffs = [];
  const n = Math.min(appLayers.length, devKeymap.layers.length);
  for (let li = 0; li < n; li++) {
    const A = appLayers[li];
    const D = devKeymap.layers[li];
    if ((A.displayName || '') && (A.displayName || '') !== (D.name || '')) nameDiffs.push({ layer: li, app: A.displayName, dev: D.name });
    const len = Math.min(A.bindings.length, D.bindings.length);
    for (let pos = 0; pos < len; pos++) {
      const enc = encodeBinding(A.bindings[pos], ctx);
      if (!enc.ok) { errors.push({ layer: li, pos, error: enc.error, missing: !!enc.missing, behavior: A.bindings[pos].behavior }); continue; }
      if (!sameDevBinding(normalize(enc.value, ctx), normalize(D.bindings[pos], ctx))) diffs.push({ layer: li, pos, enc: enc.value, dev: D.bindings[pos] });
    }
  }
  return { diffs, errors, nameDiffs, layerCountApp: appLayers.length, layerCountDev: devKeymap.layers.length };
}

/** 動作が hold-tap かどうか（UI 用） */
export function isHoldTap(parsed, label) { return !!holdTapConfig(parsed, label); }
