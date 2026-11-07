// binding をキーキャップ用ラベルと日本語の説明にする

import { expandDefines, holdTapConfig } from './dts.js';
import { parseKeyExpr, keyLabel, keyDescribe, modsToNames, MOD_USAGE_BIT } from './keycodes.js';
import { mouseButtonName, parseModMask } from './sim.js';

function kLabel(expr, ctx) {
  const e = expandDefines(expr ?? '', ctx.parsed?.defines);
  const p = parseKeyExpr(e);
  if (!p) return { label: String(expr ?? '?'), desc: `不明なキー「${expr}」`, ok: false };
  if (MOD_USAGE_BIT[p.usage] && !(p.mods & ~MOD_USAGE_BIT[p.usage])) {
    return { label: keyLabel(p, ctx.host).main, desc: p.key.ja, ok: true };
  }
  return { label: keyLabel(p, ctx.host).main, desc: keyDescribe(p, ctx.host), ok: true };
}

function modLabel(expr, ctx) {
  const e = expandDefines(expr ?? '', ctx.parsed?.defines);
  const p = parseKeyExpr(e);
  if (!p) return String(expr);
  if (MOD_USAGE_BIT[p.usage]) {
    const names = modsToNames(MOD_USAGE_BIT[p.usage] | p.mods);
    return names.join('+');
  }
  return keyLabel(p, ctx.host).main;
}

export function layerShort(n) {
  return `L${n}`;
}

function layerLong(n, ctx) {
  const name = ctx.layerNames?.[n];
  return `レイヤー${n}${name ? '「' + name + '」' : ''}`;
}

/**
 * 戻り値: { tap, hold, shift, kind, desc, ok }
 * kind: key | layer | mod | trans | none | system | mouse | morph | macro | ht | unknown
 */
export function describeBinding(b, ctx) {
  if (!b) return { tap: '', kind: 'none', desc: '未設定', ok: true };
  const defines = ctx.parsed?.defines;
  const params = b.params.map((p) => expandDefines(p, defines));
  const name = b.behavior;
  const custom = ctx.parsed?.behaviors?.[name];

  const ht = holdTapConfig(ctx.parsed, name);
  if (ht && name !== 'lt' && name !== 'mt' && custom && custom.bindings.length >= 2) {
    const holdB = { behavior: custom.bindings[0].behavior, params: [...custom.bindings[0].params, b.params[0]] };
    const tapB = { behavior: custom.bindings[1].behavior, params: [...custom.bindings[1].params, b.params[1]] };
    const h = describeBinding(holdB, ctx);
    const t = describeBinding(tapB, ctx);
    return {
      tap: t.tap, hold: h.tap.replace(/（押す間）$/, ''), kind: 'ht', ok: h.ok && t.ok,
      desc: `タップで ${t.desc} ／ 長押しで ${h.desc}（${name}: 判定 ${ht.tappingTerm}ms・${flavorJa(ht.flavor)}）`,
    };
  }

  switch (name) {
    case 'kp': {
      const k = kLabel(b.params[0], ctx);
      return { tap: k.label, kind: 'key', desc: k.desc, ok: k.ok };
    }
    case 'trans': return { tap: '▽', kind: 'trans', desc: '透過（下のレイヤーのキーがそのまま使われる）', ok: true };
    case 'none': return { tap: '✕', kind: 'none', desc: '無効（何もしない）', ok: true };
    case 'lt': {
      const k = kLabel(b.params[1], ctx);
      const n = parseInt(params[0]);
      return {
        tap: k.label, hold: layerShort(n, ctx), kind: 'ht', ok: k.ok && !isNaN(n),
        desc: `タップで ${k.desc} ／ 長押しで ${layerLong(n, ctx)}（判定 ${ht.tappingTerm}ms・${flavorJa(ht.flavor)}）`,
      };
    }
    case 'mt': {
      const k = kLabel(b.params[1], ctx);
      const m = modLabel(b.params[0], ctx);
      return {
        tap: k.label, hold: m, kind: 'ht', ok: k.ok,
        desc: `タップで ${k.desc} ／ 長押しで ${m}（判定 ${ht.tappingTerm}ms・${flavorJa(ht.flavor)}）`,
      };
    }
    case 'mo': { const n = parseInt(params[0]); return { tap: layerShort(n, ctx), hold: '押す間', kind: 'layer', desc: `押している間 ${layerLong(n, ctx)}`, ok: !isNaN(n) }; }
    case 'to': { const n = parseInt(params[0]); return { tap: '→' + layerShort(n, ctx), kind: 'layer', desc: `${layerLong(n, ctx)} に切り替え（ほかは解除）`, ok: !isNaN(n) }; }
    case 'tog': { const n = parseInt(params[0]); return { tap: '⇄' + layerShort(n, ctx), kind: 'layer', desc: `${layerLong(n, ctx)} を ON / OFF（固定）`, ok: !isNaN(n) }; }
    case 'sl': { const n = parseInt(params[0]); return { tap: '1回' + layerShort(n, ctx), kind: 'layer', desc: `次の 1 キーだけ ${layerLong(n, ctx)}`, ok: !isNaN(n) }; }
    case 'sk': { const m = modLabel(b.params[0], ctx); return { tap: '1回' + m, kind: 'mod', desc: `次の 1 キーだけ ${m} を押した状態にする`, ok: true }; }
    case 'caps_word': return { tap: 'CapsWord', kind: 'mod', desc: '単語の間だけ大文字にする', ok: true };
    case 'key_repeat': return { tap: 'リピート', kind: 'key', desc: '直前のキーをもう一度送る', ok: true };
    case 'bt': {
      const [cmd, n] = params;
      const map = {
        BT_SEL: [`BT${n}`, `Bluetooth の接続先 ${n} を選ぶ`],
        BT_CLR: ['BT消去', '今の接続先のペアリングを削除'],
        BT_CLR_ALL: ['BT全消去', 'すべてのペアリングを削除'],
        BT_NXT: ['BT→', '次の接続先'], BT_PRV: ['BT←', '前の接続先'],
        BT_DISC: [`BT${n}切断`, `接続先 ${n} を切断`],
      };
      const [t, d] = map[cmd] || ['BT', `Bluetooth ${params.join(' ')}`];
      return { tap: t, kind: 'system', desc: d, ok: true };
    }
    case 'out': return { tap: ({ OUT_USB: 'USB', OUT_BLE: 'BLE', OUT_TOG: 'USB⇄BLE' })[params[0]] || 'OUT', kind: 'system', desc: '出力先の切り替え', ok: true };
    case 'mkp': { const nm = mouseButtonName(params[0]); return { tap: nm.replace('クリック', ''), hold: 'マウス', kind: 'mouse', desc: `マウスの${nm}`, ok: true }; }
    case 'msc': {
      const dir = { SCRL_UP: '↑', SCRL_DOWN: '↓', SCRL_LEFT: '←', SCRL_RIGHT: '→' }[b.params[0]] || '';
      return { tap: 'スクロール' + dir, kind: 'mouse', desc: `マウスのスクロール${dir ? `（${dir}）` : ` ${params.join(' ')}`}`, ok: true };
    }
    case 'mmv': return { tap: 'マウス移動', kind: 'mouse', desc: `マウス移動 ${params.join(' ')}`, ok: true };
    case 'bootloader': return { tap: '書込モード', kind: 'system', desc: 'ブートローダー（ファーム書き込みモード）に入る', ok: true };
    case 'sys_reset': return { tap: '再起動', kind: 'system', desc: 'キーボードを再起動', ok: true };
    case 'soft_off': return { tap: '電源OFF', kind: 'system', desc: '電源オフ', ok: true };
    case 'studio_unlock': return { tap: 'Studio', kind: 'system', desc: 'ZMK Studio のロック解除', ok: true };
    case 'rgb_ug': return { tap: 'RGB', kind: 'system', desc: `RGB ${params.join(' ')}`, ok: true };
    case 'ext_power': return { tap: '外部電源', kind: 'system', desc: `外部電源 ${params.join(' ')}`, ok: true };
    default: break;
  }

  if (custom) {
    if (custom.compatible === 'zmk,behavior-mod-morph') {
      const a = describeBinding(custom.bindings[0], ctx);
      const s = describeBinding(custom.bindings[1], ctx);
      const mods = modsToNames(parseModMask(custom.mods)).join('/') || '修飾';
      return {
        tap: a.tap, shift: s.tap, kind: 'morph', ok: a.ok && s.ok,
        desc: `通常は ${a.desc}、${mods} と一緒なら ${s.desc}（${name}）`,
      };
    }
    if (/macro/.test(custom.compatible)) {
      return { tap: custom.displayName || name, kind: 'macro', desc: `マクロ ${name}${params.length ? '（' + params.join(' ') + '）' : ''}`, ok: true };
    }
    return { tap: name, kind: 'unknown', desc: `自作の動作 &${name}（${custom.compatible}）`, ok: true };
  }
  return { tap: '&' + name, kind: 'unknown', desc: `&${name} ${b.params.join(' ')}`, ok: true };
}

export function flavorJa(f) {
  return ({
    'hold-preferred': '長押し優先',
    balanced: 'バランス',
    'tap-preferred': 'タップ優先',
    'tap-unless-interrupted': '割り込みで長押し',
  })[f] || f;
}

/** 動作に含まれるレイヤー参照 */
export function layerRefs(b, parsed) {
  const defines = parsed?.defines;
  const p = b.params.map((x) => expandDefines(x, defines));
  if (['mo', 'to', 'tog', 'sl', 'lt'].includes(b.behavior)) return [parseInt(p[0])];
  const custom = parsed?.behaviors?.[b.behavior];
  if (custom && custom.compatible === 'zmk,behavior-hold-tap' && custom.bindings[0]?.behavior === 'mo') return [parseInt(p[0])];
  if (custom && custom.compatible === 'zmk,behavior-mod-morph') return custom.bindings.flatMap((x) => layerRefs(x, parsed));
  if (custom && /macro/.test(custom.compatible)) {
    return custom.bindings.filter((x) => ['mo', 'to', 'tog', 'sl'].includes(x.behavior) && x.params.length).map((x) => parseInt(expandDefines(x.params[0], defines)));
  }
  return [];
}

/**
 * エンコーダー（sensor-bindings）の 1 つ分を説明する
 * 戻り値: { cw: {tap, desc}, ccw: {tap, desc}, kind: 'keys'|'custom'|'trans'|'none'|'unknown', ok }
 */
export function describeSensor(b, ctx) {
  if (!b) return { kind: 'none', cw: { tap: '—', desc: '設定なし' }, ccw: { tap: '—', desc: '設定なし' }, ok: true };
  if (b.behavior === 'trans') return { kind: 'trans', cw: { tap: '▽', desc: '下のレイヤーと同じ' }, ccw: { tap: '▽', desc: '下のレイヤーと同じ' }, ok: true };
  if (b.behavior === 'none') return { kind: 'trans', cw: { tap: '▽', desc: '下のレイヤーと同じ（エンコーダーでは &none も透過になる）' }, ccw: { tap: '▽', desc: '下のレイヤーと同じ' }, ok: true };
  if (b.behavior === 'inc_dec_kp') {
    const cw = describeBinding({ behavior: 'kp', params: [b.params[0]] }, ctx);
    const ccw = describeBinding({ behavior: 'kp', params: [b.params[1]] }, ctx);
    return { kind: 'keys', cw, ccw, ok: cw.ok && ccw.ok };
  }
  const c = ctx.parsed?.behaviors?.[b.behavior];
  if (c && c.compatible === 'zmk,behavior-sensor-rotate' && c.bindings.length >= 2) {
    return { kind: 'custom', cw: describeBinding(c.bindings[0], ctx), ccw: describeBinding(c.bindings[1], ctx), ok: true };
  }
  if (c && c.compatible === 'zmk,behavior-sensor-rotate-var' && c.bindings.length >= 2) {
    const cw = describeBinding({ ...c.bindings[0], params: [...c.bindings[0].params, b.params[0]].filter((x) => x != null) }, ctx);
    const ccw = describeBinding({ ...c.bindings[1], params: [...c.bindings[1].params, b.params[1]].filter((x) => x != null) }, ctx);
    return { kind: 'custom', cw, ccw, ok: true };
  }
  return { kind: 'unknown', cw: { tap: '&' + b.behavior, desc: `&${b.behavior} ${b.params.join(' ')}` }, ccw: { tap: '&' + b.behavior, desc: '' }, ok: !!c };
}
