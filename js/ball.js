// トラックボール（PMW3610 ドライバー）の設定
// - zonkey_R.overlay: スクロール／精密／オートマウスにするレイヤー
// - zonkey_R.conf:    CPI やスクロールの速さなど

import { maskComments, parseTree, walk, propString, propInts, nodePropEdits, applyEdits } from './dts.js';

export const BALL_COMPATIBLE = 'pixart,pmw3610';

export function findTrackballNode(text) {
  const tree = parseTree(maskComments(text));
  let found = null;
  walk(tree, (n) => { if (!found && propString(n.props.compatible) === BALL_COMPATIBLE) found = n; });
  return found;
}

const toInts = (prop) => propInts(prop).map((x) => parseInt(x)).filter((x) => !isNaN(x));

/** overlay からレイヤー設定を読む */
export function readTrackball(text) {
  const node = findTrackballNode(text);
  if (!node) return { found: false, scrollLayers: [], snipeLayers: [], automouseLayer: -1, ballActions: 0 };
  const am = toInts(node.props['automouse-layer']);
  return {
    found: true,
    scrollLayers: toInts(node.props['scroll-layers']),
    snipeLayers: toInts(node.props['snipe-layers']),
    automouseLayer: am.length ? am[0] : -1,
    ballActions: node.children.length,
  };
}

const arr = (list) => {
  const v = [...new Set(list)].filter((x) => Number.isInteger(x) && x >= 0).sort((a, b) => a - b);
  return v.length ? `<${v.join(' ')}>` : null;
};

/** overlay のレイヤー設定を書き換える（ほかの部分はそのまま） */
export function writeTrackball(text, { scrollLayers, snipeLayers, automouseLayer }) {
  const node = findTrackballNode(text);
  if (!node) throw new Error('トラックボール（pixart,pmw3610）の設定が見つかりません');
  return applyEdits(text, nodePropEdits(text, node, [
    ['automouse-layer', Number.isInteger(automouseLayer) && automouseLayer >= 0 ? `<${automouseLayer}>` : null],
    ['scroll-layers', arr(scrollLayers || [])],
    ['snipe-layers', arr(snipeLayers || [])],
  ]));
}

/** レイヤーでのトラックボールの動き（ドライバーと同じく、いちばん上の有効なレイヤーで決まる） */
export function ballModeForLayer(settings, layer) {
  if (!settings) return 'move';
  if (settings.scrollLayers.includes(layer)) return 'scroll';
  if (settings.snipeLayers.includes(layer)) return 'snipe';
  return 'move';
}

// ---------------- .conf ----------------

export const BALL_CONF = [
  { key: 'PMW3610_CPI', label: 'カーソルの速さ（CPI）', type: 'int', def: 800, min: 200, max: 3200, step: 100, hint: '大きいほど速く動きます。' },
  { key: 'PMW3610_SNIPE_CPI', label: '精密モードの速さ（CPI）', type: 'int', def: 200, min: 200, max: 3200, step: 100, hint: '精密モードのレイヤーで使われます。' },
  { key: 'PMW3610_SCROLL_TICK', label: 'スクロールの重さ', type: 'int', def: 20, min: 1, max: 100, step: 1, hint: '小さいほど少し転がしただけでスクロールします。' },
  { key: 'PMW3610_AUTOMOUSE_TIMEOUT_MS', label: 'オートマウスが切れるまでの時間（ms）', type: 'int', def: 400, min: 100, max: 3000, step: 50, hint: 'トラックボールを止めてから、マウスレイヤーが解除されるまでの時間です。' },
  { key: 'PMW3610_INVERT_SCROLL_Y', label: '縦スクロールの向きを逆にする', type: 'bool', def: false },
  { key: 'PMW3610_INVERT_SCROLL_X', label: '横スクロールの向きを逆にする', type: 'bool', def: false },
];

/** 有効な CONFIG_ 行を読む（コメントアウトされた行は無視） */
export function readConf(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*CONFIG_([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function confValue(conf, item) {
  const v = conf[item.key];
  if (item.type === 'bool') return v == null ? item.def : v === 'y';
  return v == null ? item.def : parseInt(v);
}

/**
 * .conf を書き換える。changes: { KEY: value | null }（null は行を消して既定値に戻す）
 * 既存の行はその場で書き換え、ない場合は末尾にまとめて追加する。
 */
export function writeConf(text, changes) {
  const lines = String(text).split('\n');
  const done = new Set();
  const out = [];
  for (const line of lines) {
    const m = /^(\s*)CONFIG_([A-Z0-9_]+)\s*=/.exec(line);
    if (m && Object.prototype.hasOwnProperty.call(changes, m[2])) {
      const v = changes[m[2]];
      if (done.has(m[2])) continue; // 重複行は 1 つにまとめる
      done.add(m[2]);
      if (v == null) continue;
      out.push(`${m[1]}CONFIG_${m[2]}=${v}`);
      continue;
    }
    out.push(line);
  }
  const add = Object.entries(changes).filter(([k, v]) => v != null && !done.has(k));
  if (add.length) {
    while (out.length && out[out.length - 1] === '') out.pop();
    out.push('', '# トラックボールの設定（Zonkey Remap）');
    for (const [k, v] of add) out.push(`CONFIG_${k}=${v}`);
    out.push('');
  } else if (out[out.length - 1] !== '') {
    out.push('');
  }
  return out.join('\n');
}

/** 画面の値 → writeConf 用の変更（既定値と同じなら行を消す、ただし元々書いてあれば残す） */
export function confChanges(conf, values) {
  const changes = {};
  for (const item of BALL_CONF) {
    if (!(item.key in values)) continue;
    const v = values[item.key];
    const cur = confValue(conf, item);
    if (v === cur) continue;
    const str = item.type === 'bool' ? (v ? 'y' : 'n') : String(parseInt(v));
    changes[item.key] = (v === item.def && conf[item.key] == null) ? null : str;
  }
  return changes;
}
