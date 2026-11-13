// ZMK の .keymap（devicetree）を読み、レイヤーの bindings だけを書き換えて書き戻す。
// コメント・define・behavior 定義など、ほかの部分は元のテキストのまま残す。

/** コメントを空白に置き換えたテキスト（位置は元と同じ） */
export function maskComments(text) {
  const out = text.split('');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '"') {
      i++;
      while (i < n && text[i] !== '"' && text[i] !== '\n') { if (text[i] === '\\') i++; i++; }
      i++;
    } else if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') { out[i] = ' '; i++; }
    } else if (c === '/' && d === '*') {
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] !== '\n') out[i] = ' '; i++; }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
    } else {
      i++;
    }
  }
  return out.join('');
}

/** #define を集める（関数形式のマクロは除く） */
export function parseDefines(masked) {
  const defines = {};
  const re = /^[ \t]*#define[ \t]+([A-Za-z_]\w*)(?![\w(])[ \t]*(.*?)[ \t]*$/gm;
  let m;
  while ((m = re.exec(masked))) defines[m[1]] = m[2];
  return defines;
}

/** 識別子を define で展開（再帰的に） */
export function expandDefines(str, defines, depth = 0) {
  if (depth > 10 || !defines) return str;
  let changed = false;
  const out = String(str).replace(/[A-Za-z_]\w*/g, (id) => {
    if (Object.prototype.hasOwnProperty.call(defines, id) && defines[id] !== '') { changed = true; return defines[id]; }
    return id;
  });
  return changed ? expandDefines(out, defines, depth + 1) : out;
}

/**
 * devicetree の簡易パーサ。
 * ノード: { name, label, start, openBrace, closeBrace, end, props: {name: {raw, start, end, propStart, propEnd}}, children: [] }
 */
export function parseTree(masked) {
  let i = 0;
  const n = masked.length;
  const root = { name: '(root)', label: null, start: 0, end: n, props: {}, children: [] };

  function skipWs() {
    while (i < n) {
      if (/\s/.test(masked[i])) { i++; continue; }
      if (masked[i] === '#' && /^#\s*(include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|error|warning)\b/.test(masked.slice(i, i + 20))) { // プリプロセッサ行
        while (i < n && masked[i] !== '\n') {
          if (masked[i] === '\\' && masked[i + 1] === '\n') i++;
          i++;
        }
        continue;
      }
      break;
    }
  }

  function readValueEnd(from) {
    // ';' までを読む（<...> と "..." と (...) の中の ; は無視）
    let j = from;
    let angle = 0, paren = 0;
    while (j < n) {
      const c = masked[j];
      if (c === '"') { j++; while (j < n && masked[j] !== '"') { if (masked[j] === '\\') j++; j++; } }
      else if (c === '<') angle++;
      else if (c === '>') angle = Math.max(0, angle - 1);
      else if (c === '(') paren++;
      else if (c === ')') paren = Math.max(0, paren - 1);
      else if (c === ';' && angle === 0 && paren === 0) return j;
      else if (c === '}' && angle === 0 && paren === 0) return j; // ; 抜けへの保険
      j++;
    }
    return n;
  }

  function parseBody(node, untilBrace) {
    for (;;) {
      skipWs();
      if (i >= n) return;
      if (masked[i] === '}') {
        if (untilBrace) return;
        i++; continue;
      }
      if (masked[i] === ';') { i++; continue; }
      const stmtStart = i;
      // 名前（ラベル付き可）を読む
      const m = /^(?:([A-Za-z_][\w-]*)\s*:\s*)?(&?[A-Za-z0-9_,.+\-@#/]+|\/)\s*/.exec(masked.slice(i, i + 300));
      if (!m) { i++; continue; }
      const after = i + m[0].length;
      const c = masked[after];
      if (c === '{') {
        const child = { name: m[2], label: m[1] || null, start: stmtStart, openBrace: after, props: {}, children: [], parent: node };
        i = after + 1;
        parseBody(child, true);
        child.closeBrace = i;
        i++; // '}'
        skipWs();
        if (masked[i] === ';') i++;
        child.end = i;
        node.children.push(child);
      } else if (c === '=') {
        const vStart = after + 1;
        const vEnd = readValueEnd(vStart);
        node.props[m[2]] = { raw: masked.slice(vStart, vEnd).trim(), start: vStart, end: vEnd, propStart: stmtStart, propEnd: vEnd + 1 };
        i = vEnd + 1;
      } else if (c === ';') {
        node.props[m[2]] = { raw: true, start: after, end: after, propStart: stmtStart, propEnd: after + 1 };
        i = after + 1;
      } else {
        // 解釈できない文字列は 1 文字進める
        i = Math.max(i + 1, after);
      }
    }
  }

  parseBody(root, false);
  return root;
}

export function walk(node, fn) {
  fn(node);
  for (const c of node.children) walk(c, fn);
}

export function propString(prop) {
  if (!prop || prop.raw === true) return null;
  const m = /^"(.*)"$/s.exec(prop.raw);
  return m ? m[1] : prop.raw;
}

export function propInts(prop) {
  if (!prop || prop.raw === true) return [];
  const out = [];
  for (const m of prop.raw.matchAll(/<([^>]*)>/g)) {
    for (const t of m[1].trim().split(/\s+/)) if (t) out.push(t);
  }
  return out;
}

/** "<&kp A &mo 1>, <&kp B>" → [{behavior:'kp', params:['A']}, ...] */
export function parseBindings(raw) {
  if (!raw || raw === true) return [];
  let s = raw.trim();
  // < > と区切りの , を取り除く（括弧の中は残す）
  let body = '';
  let paren = 0;
  for (const ch of s) {
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (paren === 0 && (ch === '<' || ch === '>' || ch === ',')) { body += ' '; continue; }
    body += ch;
  }
  // トークン化（括弧内の空白はつなげる）
  const tokens = [];
  let cur = '';
  paren = 0;
  for (const ch of body) {
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (/\s/.test(ch) && paren === 0) { if (cur) tokens.push(cur); cur = ''; continue; }
    if (/\s/.test(ch)) continue;
    cur += ch;
  }
  if (cur) tokens.push(cur);
  const out = [];
  for (const t of tokens) {
    if (t.startsWith('&')) out.push({ behavior: t.slice(1), params: [] });
    else if (out.length) out[out.length - 1].params.push(t);
  }
  return out;
}

export function bindingToString(b) {
  if (!b) return '&none';
  return ['&' + b.behavior, ...b.params].join(' ');
}

export function parseBindingString(str) {
  const list = parseBindings(str);
  return list[0] || null;
}

const DEFAULT_HOLD_TAP = {
  lt: { flavor: 'tap-preferred', tappingTerm: 200, quickTap: -1, hold: 'mo', tap: 'kp' },
  mt: { flavor: 'hold-preferred', tappingTerm: 200, quickTap: -1, hold: 'kp', tap: 'kp' },
};

/**
 * .keymap テキストを解析する。
 * 戻り値: { text, defines, behaviors, overrides, keymapNode, layers: [...], combos, errors, warnings }
 */
export function parseKeymap(text) {
  const masked = maskComments(text);
  const defines = parseDefines(masked);
  const tree = parseTree(masked);
  const errors = [];
  const warnings = [];

  let keymapNode = null;
  const behaviors = {};
  const overrides = {};
  const combos = [];
  walk(tree, (node) => {
    const compat = propString(node.props.compatible);
    if (compat === 'zmk,keymap') keymapNode = keymapNode || node;
    if (compat && compat.startsWith('zmk,behavior') && node.label) {
      const b = {
        label: node.label,
        compatible: compat,
        bindingCells: parseInt(propInts(node.props['#binding-cells'])[0] ?? '0'),
        bindings: parseBindings(node.props.bindings?.raw),
        mods: node.props.mods ? expandDefines(propInts(node.props.mods).join(' ') || node.props.mods.raw, defines) : null,
        keepMods: node.props['keep-mods'] ? expandDefines(propInts(node.props['keep-mods']).join(' '), defines) : null,
        flavor: propString(node.props.flavor),
        tappingTerm: node.props['tapping-term-ms'] ? parseInt(expandDefines(propInts(node.props['tapping-term-ms'])[0], defines)) : null,
        quickTap: node.props['quick-tap-ms'] ? parseInt(expandDefines(propInts(node.props['quick-tap-ms'])[0], defines)) : null,
        displayName: propString(node.props['display-name']) || propString(node.props.label),
        displayNameProp: propString(node.props['display-name']),
        labelProp: propString(node.props.label),
        nodeName: node.name,
        waitMs: node.props['wait-ms'] ? parseInt(propInts(node.props['wait-ms'])[0]) : null,
        tapMs: node.props['tap-ms'] ? parseInt(propInts(node.props['tap-ms'])[0]) : null,
        node,
      };
      behaviors[node.label] = b;
    }
    if (node.name.startsWith('&') && node.parent === tree) {
      const label = node.name.slice(1);
      overrides[label] = {
        flavor: propString(node.props.flavor),
        tappingTerm: node.props['tapping-term-ms'] ? parseInt(expandDefines(propInts(node.props['tapping-term-ms'])[0], defines)) : null,
        quickTap: node.props['quick-tap-ms'] ? parseInt(expandDefines(propInts(node.props['quick-tap-ms'])[0], defines)) : null,
      };
    }
    if (compat === 'zmk,combos') {
      for (const c of node.children) {
        combos.push({
          name: c.name,
          positions: propInts(c.props['key-positions']).map((x) => parseInt(expandDefines(x, defines))),
          binding: parseBindings(c.props.bindings?.raw)[0] || null,
          layers: c.props.layers ? propInts(c.props.layers).map((x) => parseInt(expandDefines(x, defines))) : null,
          timeout: c.props['timeout-ms'] ? parseInt(propInts(c.props['timeout-ms'])[0]) : 50,
        });
      }
    }
  });

  const layers = [];
  if (!keymapNode) {
    errors.push('keymap ノード（compatible = "zmk,keymap"）が見つかりません。');
  } else {
    keymapNode.children.forEach((node) => {
      const bProp = node.props.bindings;
      layers.push({
        nodeName: node.name,
        label: node.label,
        displayName: propString(node.props['display-name']) || propString(node.props.label) || '',
        bindings: parseBindings(bProp?.raw),
        sensorBindings: node.props['sensor-bindings'] ? node.props['sensor-bindings'].raw : null,
        node,
      });
    });
    if (!layers.length) errors.push('レイヤーが 1 つもありません。');
  }

  return { text, masked, defines, behaviors, overrides, combos, keymapNode, layers, errors, warnings };
}

/** hold-tap 系 behavior の設定（lt / mt / 自作） */
export function holdTapConfig(parsed, label) {
  const base = DEFAULT_HOLD_TAP[label];
  const def = parsed?.behaviors?.[label];
  const ov = parsed?.overrides?.[label] || {};
  if (!base && !(def && def.compatible === 'zmk,behavior-hold-tap')) return null;
  const cfg = { ...(base || { flavor: 'hold-preferred', tappingTerm: 200, quickTap: -1 }) };
  if (def) {
    if (def.flavor) cfg.flavor = def.flavor;
    if (def.tappingTerm != null) cfg.tappingTerm = def.tappingTerm;
    if (def.quickTap != null) cfg.quickTap = def.quickTap;
    if (def.bindings.length >= 2) { cfg.hold = def.bindings[0].behavior; cfg.tap = def.bindings[1].behavior; }
  }
  if (ov.flavor) cfg.flavor = ov.flavor;
  if (ov.tappingTerm != null) cfg.tappingTerm = ov.tappingTerm;
  if (ov.quickTap != null) cfg.quickTap = ov.quickTap;
  return cfg;
}

// ---------------- 書き出し ----------------

// rowSizes: [[左, 右], ...] または [行のキー数, ...]
export function formatBindingRows(bindings, rowSizes) {
  const strs = bindings.map(bindingToString);
  const rows = [];
  let idx = 0;
  for (const size of rowSizes) {
    if (idx >= strs.length) break;
    const [l, r] = Array.isArray(size) ? size : [size, 0];
    rows.push([strs.slice(idx, idx + l), strs.slice(idx + l, idx + l + r)]);
    idx += l + r;
  }
  if (idx < strs.length) rows.push([strs.slice(idx), []]);
  const wl = [], wr = [];
  for (const [L, R] of rows) {
    L.forEach((s, c) => { wl[c] = Math.max(wl[c] || 0, s.length); });
    R.forEach((s, c) => { wr[c] = Math.max(wr[c] || 0, s.length); });
  }
  const leftWidth = wl.reduce((a, w) => a + w + 2, 0);
  return rows.map(([L, R]) => {
    let line = L.map((s, c) => s.padEnd(wl[c] + 2)).join('');
    if (R.length) {
      line = line.padEnd(leftWidth + 4);
      line += R.map((s, c) => (c === R.length - 1 ? s : s.padEnd(wr[c] + 2))).join('');
    }
    return line.trimEnd();
  }).join('\n');
}

function lineIndentAt(text, pos) {
  const ls = text.lastIndexOf('\n', pos - 1) + 1;
  const m = /^[ \t]*/.exec(text.slice(ls));
  return m ? m[0] : '';
}

function quote(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function sanitizeNodeName(s, fallback) {
  const t = String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[a-z]/.test(t) ? t : fallback;
}

/**
 * 編集後のレイヤーから .keymap を書き出す。
 * layers: [{ origIndex (元のレイヤー番号 or null), displayName, bindings, sensorBindings }]
 */
export function serializeKeymap(parsed, layers, rowSizes) {
  const text = parsed.text;
  const edits = []; // {start, end, str}
  const kept = new Set(layers.filter((l) => l.origIndex != null).map((l) => l.origIndex));

  parsed.layers.forEach((orig, idx) => {
    const node = orig.node;
    if (!kept.has(idx)) {
      // 削除: 行頭の空白から消す
      let s = node.start;
      while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
      let e = node.end;
      if (text[e] === '\n') e++;
      edits.push({ start: s, end: e, str: '' });
    }
  });

  for (const l of layers) {
    if (l.origIndex == null) continue;
    const orig = parsed.layers[l.origIndex];
    const node = orig.node;
    const bProp = node.props.bindings;
    if (bProp) {
      const changed = l.bindings.length !== orig.bindings.length || l.bindings.some((b, i) => bindingToString(b) !== bindingToString(orig.bindings[i]));
      if (changed) {
        const ind = lineIndentAt(text, bProp.propStart);
        edits.push({ start: bProp.start, end: bProp.end, str: ` <\n${formatBindingRows(l.bindings, rowSizes)}\n${ind}>` });
      }
    }
    const nameProp = node.props['display-name'] || node.props.label;
    const newName = l.displayName || '';
    if (newName !== (orig.displayName || '')) {
      if (nameProp) {
        edits.push({ start: nameProp.start, end: nameProp.end, str: ' ' + quote(newName) });
      } else if (newName) {
        const ind = lineIndentAt(text, node.start) + '    ';
        edits.push({ start: node.openBrace + 1, end: node.openBrace + 1, str: `\n${ind}display-name = ${quote(newName)};` });
      }
    }
    if ((l.sensorBindings || null) !== (orig.sensorBindings || null)) {
      const sp = node.props['sensor-bindings'];
      if (sp && l.sensorBindings) edits.push({ start: sp.start, end: sp.end, str: ' ' + l.sensorBindings });
      else if (sp && !l.sensorBindings) edits.push({ start: sp.propStart, end: sp.propEnd, str: '' });
      else if (!sp && l.sensorBindings) {
        const ind = lineIndentAt(text, node.start) + '    ';
        edits.push({ start: node.closeBrace, end: node.closeBrace, str: `\n${ind}sensor-bindings = ${l.sensorBindings};\n${lineIndentAt(text, node.start)}` });
      }
    }
  }

  // 新しいレイヤーを keymap ノードの末尾に追加
  const added = layers.map((l, i) => ({ l, i })).filter((x) => x.l.origIndex == null);
  if (added.length && parsed.keymapNode) {
    const km = parsed.keymapNode;
    const used = new Set(parsed.layers.map((l) => l.nodeName));
    const ind = lineIndentAt(text, km.start) + '    ';
    let str = '';
    for (const { l, i } of added) {
      let name = sanitizeNodeName(l.displayName, `layer_${i}`);
      while (used.has(name)) name += '_';
      used.add(name);
      str += `\n${ind}${name} {\n`;
      if (l.displayName) str += `${ind}    display-name = ${quote(l.displayName)};\n`;
      str += `${ind}    bindings = <\n${formatBindingRows(l.bindings, rowSizes)}\n${ind}    >;\n`;
      if (l.sensorBindings) str += `${ind}    sensor-bindings = ${l.sensorBindings};\n`;
      str += `${ind}};\n`;
    }
    // closeBrace の直前の空白を保ったまま差し込む
    let pos = km.closeBrace;
    while (pos > 0 && (text[pos - 1] === ' ' || text[pos - 1] === '\t')) pos--;
    edits.push({ start: pos, end: pos, str: str.replace(/^\n/, '') });
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.str + out.slice(e.end);
  return out;
}

/** 新規作成用のひな形 */
export function templateKeymap() {
  return `#include <behaviors.dtsi>
#include <dt-bindings/zmk/bt.h>
#include <dt-bindings/zmk/keys.h>
#include <dt-bindings/zmk/pointing.h>

/ {
    keymap {
        compatible = "zmk,keymap";

        default_layer {
            display-name = "基本";
            bindings = <
&kp Q      &kp W     &kp E     &kp R          &kp T                                         &kp Y      &kp U          &kp I      &kp O    &kp P
&kp A      &kp S     &kp D     &kp F          &kp G        &none              &none         &kp H      &kp J          &kp K      &kp L    &kp MINUS
&kp LSHFT  &kp Z     &kp X     &kp C          &kp V        &kp B              &none         &kp N      &kp M          &kp COMMA  &kp DOT  &kp SLASH
&kp LCTRL  &kp LGUI  &kp LALT  &kp INT_MUHENKAN  &lt 1 SPACE  &kp INT_HENKAN                  &kp BSPC   &kp ENTER                                  &kp DEL
            >;
        };

        layer_1 {
            display-name = "数字";
            bindings = <
&kp N1     &kp N2    &kp N3    &kp N4         &kp N5                                        &kp N6     &kp N7         &kp N8     &kp N9   &kp N0
&trans     &trans    &trans    &trans         &trans       &trans             &trans        &kp LEFT   &kp DOWN       &kp UP     &kp RIGHT  &trans
&trans     &trans    &trans    &trans         &trans       &trans             &trans        &trans     &trans         &trans     &trans   &trans
&trans     &trans    &trans    &trans         &trans       &trans                           &trans     &trans                                     &trans
            >;
        };
    };
};
`;
}

// ---------------- 自作の動作（behaviors）の作成・編集 ----------------

const BUILTIN_LABELS = new Set([
  'kp', 'kt', 'lt', 'mt', 'mo', 'to', 'tog', 'sl', 'sk', 'trans', 'none', 'bt', 'out', 'mkp', 'msc', 'mmv',
  'caps_word', 'key_repeat', 'bootloader', 'sys_reset', 'soft_off', 'studio_unlock', 'gresc', 'rgb_ug', 'bl',
  'ext_power', 'inc_dec_kp',
]);

export const BEHAVIOR_TYPES = {
  'mod-morph': 'zmk,behavior-mod-morph',
  'hold-tap': 'zmk,behavior-hold-tap',
  macro: 'zmk,behavior-macro',
  'sensor-rotate': 'zmk,behavior-sensor-rotate',
};

export function behaviorType(compatible) {
  return Object.keys(BEHAVIOR_TYPES).find((k) => BEHAVIOR_TYPES[k] === compatible) || null;
}

export function validateBehaviorLabel(label, parsed, editing) {
  if (!/^[a-z_][a-z0-9_]*$/.test(label || '')) return '名前は半角の小文字・数字・_ で、先頭は英字にしてください（例: my_shift2）';
  if (label.length > 20) return '名前は 20 文字以内にしてください';
  if (BUILTIN_LABELS.has(label)) return `「${label}」は ZMK の組み込み動作と同じ名前です`;
  if (label !== editing && parsed?.behaviors?.[label]) return `「${label}」はすでにあります`;
  return null;
}

const MOD_MASKS = [['MOD_LCTL', 1], ['MOD_LSFT', 2], ['MOD_LALT', 4], ['MOD_LGUI', 8], ['MOD_RCTL', 16], ['MOD_RSFT', 32], ['MOD_RALT', 64], ['MOD_RGUI', 128]];
export function modMaskExpr(bits) {
  const names = MOD_MASKS.filter(([, b]) => bits & b).map(([n]) => n);
  return names.length ? `<(${names.join('|')})>` : null;
}

/**
 * def: { type, label, displayName, ... }
 *  mod-morph: { normal: '&kp N2', morphed: '&kp LBKT', mods: bits, keepMods: bits }
 *  hold-tap:  { hold: 'mo'|'kp', tap: 'kp', flavor, tappingTerm, quickTap }
 *  macro:     { bindings: '&kp H &kp I', waitMs, tapMs }
 * 戻り値: [ [prop, value|null], ... ]（順番どおりに書く）
 */
function behaviorProps(def) {
  const props = [['compatible', `"${BEHAVIOR_TYPES[def.type]}"`]];
  props.push(['display-name', def.displayName ? quote(def.displayName) : null]);
  if (def.type === 'mod-morph') {
    props.push(['#binding-cells', '<0>']);
    props.push(['bindings', `<${def.normal}>, <${def.morphed}>`]);
    props.push(['mods', modMaskExpr(def.mods) || '<(MOD_LSFT|MOD_RSFT)>']);
    props.push(['keep-mods', modMaskExpr(def.keepMods || 0)]);
  } else if (def.type === 'hold-tap') {
    props.push(['#binding-cells', '<2>']);
    props.push(['bindings', `<&${def.hold}>, <&${def.tap}>`]);
    props.push(['flavor', `"${def.flavor || 'balanced'}"`]);
    props.push(['tapping-term-ms', `<${parseInt(def.tappingTerm) || 200}>`]);
    props.push(['quick-tap-ms', parseInt(def.quickTap) > 0 ? `<${parseInt(def.quickTap)}>` : null]);
  } else if (def.type === 'sensor-rotate') {
    props.push(['#sensor-binding-cells', '<0>']);
    props.push(['bindings', `<${def.cw}>, <${def.ccw}>`]);
    props.push(['tap-ms', parseInt(def.tapMs) > 0 ? `<${parseInt(def.tapMs)}>` : null]);
  } else if (def.type === 'macro') {
    props.push(['#binding-cells', '<0>']);
    props.push(['wait-ms', parseInt(def.waitMs) >= 0 && def.waitMs !== '' && def.waitMs != null ? `<${parseInt(def.waitMs)}>` : null]);
    props.push(['tap-ms', parseInt(def.tapMs) >= 0 && def.tapMs !== '' && def.tapMs != null ? `<${parseInt(def.tapMs)}>` : null]);
    props.push(['bindings', `<${def.bindings.trim()}>`]);
  }
  return props;
}

/** 自作の動作を追加・更新したテキストを返す */
export function upsertBehavior(text, def) {
  const parsed = parseKeymap(text);
  const props = behaviorProps(def);
  const existing = parsed.behaviors[def.label];
  const edits = [];
  if (existing) {
    const node = existing.node;
    const ind = lineIndentAt(text, node.start) + '    ';
    let insertAt = node.closeBrace;
    while (insertAt > 0 && (text[insertAt - 1] === ' ' || text[insertAt - 1] === '\t')) insertAt--;
    let add = '';
    for (const [name, value] of props) {
      if (name === 'compatible') continue;
      const p = node.props[name];
      if (p && value != null) {
        if (p.raw !== value) edits.push({ start: p.start, end: p.end, str: ' ' + value });
      } else if (p && value == null) {
        let s = p.propStart;
        while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
        let e = p.propEnd;
        if (text[e] === '\n') e++;
        edits.push({ start: s, end: e, str: '' });
      } else if (!p && value != null) {
        add += `${ind}${name} = ${value};\n`;
      }
    }
    if (add) edits.push({ start: insertAt, end: insertAt, str: add });
  } else {
    // 入れる場所: behaviors / macros ノード、なければ keymap ノードの直前
    let container = null;
    let before = null;
    const roots = [];
    const tree = parseTree(parsed.masked);
    for (const c of tree.children) if (c.name === '/') roots.push(c);
    const want = def.type === 'macro' ? ['macros', 'behaviors'] : ['behaviors'];
    for (const w of want) {
      for (const r of roots) { const n = r.children.find((c) => c.name === w); if (n) { container = n; break; } }
      if (container) break;
    }
    if (!container) {
      const km = parsed.keymapNode;
      before = km;
    }
    const nodeText = (ind) => `${ind}${def.label}: ${def.label} {\n${props.filter(([, v]) => v != null).map(([n, v]) => `${ind}    ${n} = ${v};`).join('\n')}\n${ind}};\n`;
    if (container) {
      const ind = lineIndentAt(text, container.start) + '    ';
      let pos = container.closeBrace;
      while (pos > 0 && (text[pos - 1] === ' ' || text[pos - 1] === '\t')) pos--;
      const needNl = text[pos - 1] !== '\n';
      edits.push({ start: pos, end: pos, str: (needNl ? '\n' : '') + '\n' + nodeText(ind) });
    } else if (before) {
      const ind = lineIndentAt(text, before.start);
      const pos = text.lastIndexOf('\n', before.start - 1) + 1;
      edits.push({ start: pos, end: pos, str: nodeText(ind) + '\n' });
    } else {
      throw new Error('動作を追加する場所（/ { ... }）が見つかりません');
    }
  }
  edits.sort((a, b) => b.start - a.start);
  let out = text;
  for (const e of edits) out = out.slice(0, e.start) + e.str + out.slice(e.end);
  return out;
}

/** 自作の動作を削除したテキストを返す */
export function removeBehavior(text, label) {
  const parsed = parseKeymap(text);
  const b = parsed.behaviors[label];
  if (!b) return text;
  let s = b.node.start;
  while (s > 0 && (text[s - 1] === ' ' || text[s - 1] === '\t')) s--;
  let e = b.node.end;
  if (text[e] === '\n') e++;
  return text.slice(0, s) + text.slice(e);
}

/** その動作を使っている場所 */
export function behaviorUsages(parsed, layers, label) {
  const out = [];
  layers.forEach((L, li) => L.bindings.forEach((b, pos) => { if (b.behavior === label) out.push({ layer: li, pos }); }));
  for (const other of Object.values(parsed.behaviors)) {
    if (other.label !== label && other.bindings.some((b) => b.behavior === label)) out.push({ behavior: other.label });
  }
  if (new RegExp(`&${label}\\b`).test(parsed.masked.slice(0, parsed.keymapNode?.start ?? 0).replace(/^[ \t]*#.*$/gm, '')) && !out.length) {
    // combos などからの参照
    out.push({ other: true });
  }
  return out;
}

/** sensor-bindings の文字列 ⇄ binding の配列 */
export function parseSensorBindings(raw) {
  return raw ? parseBindings(raw) : [];
}
export function sensorBindingsToString(list) {
  const items = list.filter(Boolean);
  if (!items.length) return null;
  return items.map((b) => `<${bindingToString(b)}>`).join(', ');
}
