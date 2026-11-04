// キーマップの自動チェック

import { describeBinding, layerRefs } from './describe.js';
import { expandDefines } from './dts.js';
import { parseKeyExpr, charFor, producesText, SHIFT_MASK } from './keycodes.js';

const BUILTIN = new Set([
  'kp', 'trans', 'none', 'lt', 'mt', 'mo', 'to', 'tog', 'sl', 'sk', 'caps_word', 'key_repeat', 'bt', 'out',
  'mkp', 'msc', 'mmv', 'bootloader', 'sys_reset', 'soft_off', 'studio_unlock', 'rgb_ug', 'ext_power', 'bl',
  'gresc', 'kt', 'inc_dec_kp',
]);

/**
 * 戻り値: [{ level: 'error'|'warn'|'info', msg, layer, pos }]
 */
export function lintKeymap({ parsed, layers, keyCount, host, mouseLayer, layerNames, positionName }) {
  const out = [];
  const ctx = { parsed, host, layerNames };
  const n = layers.length;
  const reach = new Map(); // layer → [{how, from}]

  layers.forEach((L, li) => {
    if (L.bindings.length !== keyCount) {
      out.push({ level: 'error', layer: li, msg: `レイヤー${li}: キーの数が ${L.bindings.length} 個です（Zonkey は ${keyCount} 個）。` });
    }
    L.bindings.forEach((b, pos) => {
      const where = `レイヤー${li}・${positionName(pos)}`;
      if (!BUILTIN.has(b.behavior) && !parsed?.behaviors?.[b.behavior]) {
        out.push({ level: 'error', layer: li, pos, msg: `${where}: 「&${b.behavior}」という動作が定義されていません。` });
        return;
      }
      const d = describeBinding(b, ctx);
      if (!d.ok) out.push({ level: 'error', layer: li, pos, msg: `${where}: ${d.desc}` });
      for (const r of layerRefs(b, parsed)) {
        if (isNaN(r) || r < 0 || r >= n) out.push({ level: 'error', layer: li, pos, msg: `${where}: 存在しないレイヤー ${r} を参照しています。` });
        else {
          if (!reach.has(r)) reach.set(r, []);
          reach.get(r).push({ how: b.behavior, from: li, pos });
        }
      }
      // JIS の PC での落とし穴
      if (host === 'jis' && b.behavior === 'kp') {
        const raw = b.params[0] || '';
        const e = expandDefines(raw, parsed?.defines);
        const p = parseKeyExpr(e);
        if (p && p.key && producesText(p.key, 'jis') && p.key.cat !== 'alpha') {
          const shift = !!(p.mods & SHIFT_MASK);
          const us = charFor(p.key, shift, 'us');
          const jis = charFor(p.key, shift, 'jis');
          // 名前が US の記号を指していて、JIS では別の文字が出るもの
          if (us && jis !== us && raw === e && !/^N\d$/.test(raw)) {
            out.push({ level: 'info', layer: li, pos, msg: `${where}: &kp ${raw} は US 配列では「${us}」ですが、JIS の PC では「${jis || '(何も出ない)'}」が入力されます。` });
          }
        }
      }
    });
  });

  // mod-morph の中身（JIS で文字が変わるもの）
  if (host === 'jis') {
    const used = new Set(layers.flatMap((L) => L.bindings.map((b) => b.behavior)));
    for (const name of used) {
      const c = parsed?.behaviors?.[name];
      if (!c || c.compatible !== 'zmk,behavior-mod-morph') continue;
      c.bindings.forEach((b, i) => {
        if (b.behavior !== 'kp') return;
        const raw = b.params[0] || '';
        const e = expandDefines(raw, parsed?.defines);
        const p = parseKeyExpr(e);
        if (!p || !p.key || !producesText(p.key, 'jis') || p.key.cat === 'alpha') return;
        // mod-morph の 2 つ目は Shift を外して送るので、実際の Shift は式に含まれる分だけ
        const shift = !!(p.mods & SHIFT_MASK);
        const us = charFor(p.key, shift, 'us');
        const jis = charFor(p.key, shift, 'jis');
        if (us && jis !== us && raw === e && !/^N\d$/.test(raw)) {
          out.push({ level: 'info', msg: `動作 ${name}（${i === 0 ? '通常時' : 'Shift 時'}）: &kp ${raw} は US 配列では「${us}」ですが、JIS の PC では「${jis || '(何も出ない)'}」が入力されます。` });
        }
      });
    }
  }

  for (let l = 1; l < n; l++) {
    if (l === mouseLayer) continue;
    if (!reach.has(l)) out.push({ level: 'warn', layer: l, msg: `レイヤー${l} に切り替えるキーがどこにもありません（使われないレイヤー）。` });
    else {
      const ways = reach.get(l);
      const latching = ways.filter((w) => w.how === 'to' || w.how === 'tog');
      if (latching.length && latching.length === ways.length) {
        const L = layers[l];
        const back = L.bindings.some((b) => (b.behavior === 'to' && parseInt(expandDefines(b.params[0], parsed?.defines)) !== l) ||
          (b.behavior === 'tog' && parseInt(expandDefines(b.params[0], parsed?.defines)) === l)) ||
          latching.some((w) => w.how === 'tog' && L.bindings[w.pos]?.behavior === 'trans');
        if (!back) out.push({ level: 'warn', layer: l, msg: `レイヤー${l} は固定（to / tog）で入りますが、そのレイヤーに戻るためのキーがありません。` });
      }
    }
  }
  if (mouseLayer != null && mouseLayer >= n) {
    out.push({ level: 'warn', msg: `自動マウスレイヤー（${mouseLayer}）がありません。` });
  }
  return out;
}
