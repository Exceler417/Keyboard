// キーマップを印刷・PDF 用の SVG にする

import { ZONKEY_LAYOUT, TRACKBALL, ENCODERS, layoutBounds } from './layout.js';
import { describeBinding, describeSensor, layerRefs } from './describe.js';
import { parseSensorBindings, expandDefines } from './dts.js';
import { ballModeForLayer } from './ball.js';

const U = 60; // 1 キーの大きさ（SVG の単位）

const COLORS = {
  key: ['#ffffff', '#9aa1b1'],
  layer: ['#e8f0ff', '#6f8fd8'],
  ht: ['#fff4dc', '#d9a441'],
  mod: ['#f1ecff', '#9a82e0'],
  system: ['#ffecec', '#d98a8a'],
  mouse: ['#e7f7ed', '#6fbf8d'],
  morph: ['#e6f6f8', '#5fb3bc'],
  macro: ['#fdf0f7', '#d38ab3'],
  trans: ['#ffffff', '#c3c8d4'],
  none: ['#f4f5f8', '#c3c8d4'],
  unknown: ['#ffffff', '#d9534f'],
};

export const KIND_LEGEND = [
  ['layer', 'レイヤー操作'],
  ['ht', 'タップ／長押しで別の動き'],
  ['mod', '修飾キー'],
  ['morph', 'Shift などで変わるキー'],
  ['mouse', 'マウス'],
  ['system', 'Bluetooth・システム'],
  ['macro', 'マクロ'],
];

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fit(text, base, maxW) {
  // ざっくりした文字幅の見積もり（全角 1、半角 0.6）
  let w = 0;
  for (const ch of String(text)) w += /[\x20-\x7e]/.test(ch) ? 0.6 : 1;
  const size = Math.min(base, maxW / Math.max(w, 1));
  return Math.max(7, Math.round(size * 10) / 10);
}

function effective(layers, layerIdx, pos) {
  for (let l = layerIdx; l >= 0; l--) {
    const b = layers[l]?.bindings[pos];
    if (b && b.behavior !== 'trans') return { binding: b, layer: l };
  }
  return { binding: null, layer: 0 };
}

function effectiveSensor(layers, layerIdx, ei) {
  for (let l = layerIdx; l >= 0; l--) {
    const b = parseSensorBindings(layers[l]?.sensorBindings)[ei];
    if (b && b.behavior !== 'trans' && b.behavior !== 'none') return { binding: b, layer: l };
  }
  return { binding: null, layer: 0 };
}

/** そのレイヤーに入る方法（例: 「L0 の Space を長押し」） */
export function layerActivators(layers, target, parsed, names) {
  const out = [];
  const how = { mo: '押している間', lt: '長押し', tog: '押して固定（もう一度で解除）', to: '押して切り替え', sl: '次の 1 キーだけ' };
  layers.forEach((L, li) => {
    L.bindings.forEach((b, pos) => {
      if (li === target) return;
      const refs = layerRefs(b, parsed);
      if (!refs.includes(target)) return;
      const d = describeBinding(b, { parsed, host: 'jis', layerNames: names });
      const custom = parsed?.behaviors?.[b.behavior];
      const kind = how[b.behavior] || (custom?.compatible === 'zmk,behavior-hold-tap' ? '長押し' : '');
      const keyName = b.behavior === 'lt' || custom?.compatible === 'zmk,behavior-hold-tap' ? d.tap : `L${target}キー`;
      out.push(`L${li} の「${keyName}」${kind ? 'を' + kind : ''}`);
    });
  });
  return [...new Set(out)];
}

/**
 * 1 レイヤー分の SVG を作る
 * opts: { layers, parsed, host, names, layerIdx, mono, showTrans, ball, mouseLayer }
 */
export function layerSvg(opts) {
  const { layers, parsed, host, names, layerIdx, mono, showTrans, ball, mouseLayer } = opts;
  const ctx = { parsed, host, layerNames: names };
  const b = layoutBounds();
  const offY = b.minY;
  const W = b.w * U;
  const H = (b.h - offY) * U;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -6 ${W + 12} ${H + 12}" class="print-svg" font-family="'Hiragino Sans','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif">`);

  // トラックボール
  const tbMode = ballModeForLayer(ball, layerIdx);
  const tbLabel = tbMode === 'scroll' ? 'スクロール' : tbMode === 'snipe' ? '精密' : layerIdx === mouseLayer ? 'マウス\nレイヤー' : 'トラック\nボール';
  const tbFill = mono ? '#ffffff' : tbMode === 'scroll' ? '#cfeedd' : tbMode === 'snipe' ? '#fbe6c4' : '#dbe3f3';
  parts.push(`<circle cx="${TRACKBALL.cx * U}" cy="${(TRACKBALL.cy - offY) * U}" r="${TRACKBALL.r * U}" fill="${tbFill}" stroke="#7d869a" stroke-width="2"/>`);
  tbLabel.split('\n').forEach((line, i, arr) => {
    parts.push(`<text x="${TRACKBALL.cx * U}" y="${(TRACKBALL.cy - offY) * U + (i - (arr.length - 1) / 2) * 16 + 5}" text-anchor="middle" font-size="14" fill="#333">${esc(line)}</text>`);
  });

  // エンコーダー
  ENCODERS.forEach((enc, ei) => {
    const own = parseSensorBindings(layers[layerIdx]?.sensorBindings)[ei];
    const eff = (!own || own.behavior === 'trans' || own.behavior === 'none') ? effectiveSensor(layers, 0, ei) : { binding: own, layer: layerIdx };
    const d = describeSensor(eff.binding, ctx);
    const cx = enc.cx * U;
    const cy = (enc.cy - offY) * U;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${enc.r * U}" fill="#ffffff" stroke="#7d869a" stroke-width="2" ${own && own.behavior !== 'trans' ? '' : 'stroke-dasharray="4 3"'}/>`);
    const cw = '↻' + d.cw.tap;
    const ccw = '↺' + d.ccw.tap;
    parts.push(`<text x="${cx}" y="${cy - 3}" text-anchor="middle" font-size="${fit(cw, 11, enc.r * U * 1.7)}" fill="#333">${esc(cw)}</text>`);
    parts.push(`<text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="${fit(ccw, 11, enc.r * U * 1.7)}" fill="#333">${esc(ccw)}</text>`);
  });

  // キー
  ZONKEY_LAYOUT.forEach((k, pos) => {
    const own = layers[layerIdx]?.bindings[pos] || { behavior: 'none', params: [] };
    let d = describeBinding(own, ctx);
    let kind = d.kind;
    let faded = false;
    if (kind === 'trans') {
      if (showTrans && layerIdx > 0) {
        // 透過キーの下で実際に使われるのは、ふつうは基本のレイヤー0
        const eff = effective(layers, 0, pos);
        d = eff.binding ? describeBinding(eff.binding, ctx) : { tap: '', kind: 'none' };
        faded = true;
      } else {
        d = { tap: '', kind: 'trans' };
      }
    }
    const [fill, stroke] = mono ? ['#ffffff', '#555'] : (COLORS[faded ? 'trans' : kind] || COLORS.key);
    const x = k.x * U + 3;
    const y = (k.y - offY) * U + 3;
    const s = U - 6;
    const rot = k.r ? ` transform="rotate(${k.r} ${k.rx * U} ${(k.ry - offY) * U})"` : '';
    parts.push(`<g${rot}>`);
    parts.push(`<rect x="${x}" y="${y}" width="${s}" height="${s}" rx="7" fill="${fill}" stroke="${stroke}" stroke-width="${faded || kind === 'trans' ? 1.2 : 1.6}" ${faded || kind === 'trans' ? 'stroke-dasharray="4 3"' : ''}/>`);
    const color = faded ? '#9aa1b1' : '#1d2230';
    const cx = x + s / 2;
    const tap = String(d.tap ?? '');
    if (tap) parts.push(`<text x="${cx}" y="${y + s / 2 + (d.hold ? 0 : 5)}" text-anchor="middle" font-size="${fit(tap, 17, s - 6)}" font-weight="600" fill="${color}">${esc(tap)}</text>`);
    if (d.hold) parts.push(`<text x="${cx}" y="${y + s - 7}" text-anchor="middle" font-size="${fit(d.hold, 10, s - 6)}" fill="${faded ? '#b4bac6' : '#5b6475'}">${esc(d.hold)}</text>`);
    if (d.shift) parts.push(`<text x="${x + s - 4}" y="${y + 11}" text-anchor="end" font-size="${fit('⇧' + d.shift, 9.5, s / 2)}" fill="${faded ? '#b4bac6' : '#5b6475'}">${esc('⇧' + d.shift)}</text>`);
    parts.push('</g>');
  });

  parts.push('</svg>');
  return parts.join('');
}

export function legendSvg(mono) {
  const items = mono ? [['trans', '点線: 透過（下のレイヤーと同じ）']] : [...KIND_LEGEND, ['trans', '▽ 透過（下のレイヤーと同じ）']];
  const w = 210;
  const rows = Math.ceil(items.length / 4);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w * 4} ${rows * 26}" class="print-legend" font-family="'Hiragino Sans','Noto Sans JP','Yu Gothic UI','Meiryo',sans-serif">`];
  items.forEach(([kind, label], i) => {
    const x = (i % 4) * w;
    const y = Math.floor(i / 4) * 26;
    const [fill, stroke] = mono ? ['#ffffff', '#555'] : COLORS[kind];
    parts.push(`<rect x="${x + 2}" y="${y + 4}" width="18" height="18" rx="4" fill="${fill}" stroke="${stroke}" ${kind === 'trans' ? 'stroke-dasharray="3 2"' : ''}/>`);
    parts.push(`<text x="${x + 26}" y="${y + 18}" font-size="13" fill="#333">${esc(label)}</text>`);
  });
  parts.push('</svg>');
  return parts.join('');
}

/** キーの割り当ての一覧（PDF 末尾の表用）: 自作の動作 */
export function customBehaviorRows(parsed, host, names) {
  const ctx = { parsed, host, layerNames: names };
  return Object.values(parsed?.behaviors || {})
    .filter((c) => !/sensor-rotate/.test(c.compatible))
    .map((c) => {
      if (/macro/.test(c.compatible)) {
        const seq = c.bindings.filter((b) => !/^macro_/.test(b.behavior)).map((b) => describeBinding(b, ctx).tap).join(' → ');
        return { name: '&' + c.label, desc: `マクロ: ${seq || '（中身なし）'}${c.bindingCells ? '（割り当てるときに指定したキーを使う）' : ''}` };
      }
      const params = Array.from({ length: c.bindingCells || 0 }, (_, i) => (i === 0 && c.compatible === 'zmk,behavior-hold-tap' && c.bindings[0]?.behavior === 'mo' ? '1' : 'A'));
      const d = describeBinding({ behavior: c.label, params }, ctx);
      return { name: '&' + c.label, desc: (params.length ? `例: &${c.label} ${params.join(' ')} → ` : '') + d.desc };
    });
}

export { expandDefines };
