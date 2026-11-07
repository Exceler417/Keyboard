// キーマップの動作シミュレーター。
// ZMK の動きを簡略化して再現する（レイヤー、hold-tap、mod-morph、マクロ、スティッキー等）。

import { expandDefines, holdTapConfig } from './dts.js';
import {
  parseKeyExpr, keyLabel, charFor, producesText, MOD_USAGE_BIT, MOD_BITS,
  SHIFT_MASK, CTRL_MASK, ALT_MASK, GUI_MASK, modsToNames, keyByName, keyByUsage,
} from './keycodes.js';

const MOD_NAME_BITS = {
  MOD_LCTL: 1, MOD_LSFT: 2, MOD_LALT: 4, MOD_LGUI: 8, MOD_RCTL: 16, MOD_RSFT: 32, MOD_RALT: 64, MOD_RGUI: 128,
};

export function parseModMask(str) {
  if (!str) return 0;
  let m = 0;
  for (const id of String(str).match(/MOD_[A-Z]+/g) || []) m |= MOD_NAME_BITS[id] || 0;
  return m;
}

/** 修飾キー名（LSHIFT 等）→ ビット */
export function modBitFromExpr(expr) {
  const p = parseKeyExpr(expr);
  if (p && MOD_USAGE_BIT[p.usage]) return MOD_USAGE_BIT[p.usage] | p.mods;
  return p ? p.mods : 0;
}

/** 自動マウスレイヤーの番号を推測する */
export function guessMouseLayer(parsed, layerCount) {
  const d = parsed?.defines || {};
  for (const name of ['MOUSE', 'MOUSE_LAYER', 'MS', 'AML']) {
    if (d[name] != null && /^\d+$/.test(expandDefines(d[name], d).trim())) {
      const v = parseInt(expandDefines(d[name], d));
      if (v < layerCount) return v;
    }
  }
  const layers = parsed?.layers || [];
  const idx = layers.findIndex((l) => /mouse|マウス/i.test(l.displayName + ' ' + l.nodeName));
  if (idx >= 0) return idx;
  return null;
}

export class Simulator {
  /**
   * opts: { parsed, layers: [[binding...]...], host: 'jis'|'us', now, setTimer, clearTimer, onChange }
   */
  constructor(opts) {
    this.parsed = opts.parsed;
    this.layers = opts.layers;
    this.host = opts.host || 'jis';
    this.now = opts.now || (() => performance.now());
    this.setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer || ((t) => clearTimeout(t));
    this.onChange = opts.onChange || (() => {});
    this.mouseLayer = opts.mouseLayer ?? null;
    this.reset();
  }

  reset() {
    this.layerCounts = new Map(); // mo / hold 由来
    this.toggled = new Set();
    this.sticky = new Set();
    this.mouseActive = false;
    this.heldMods = new Map(); // bit → count
    this.stickyMods = 0;
    this.capsWord = false;
    this.capsLock = false;
    this.pressed = new Map(); // pos → { release: fn, label }
    this.pending = null;
    this.queue = [];
    this.lastTap = new Map();
    this.lastKey = null;
    this.text = '';
    this.log = [];
    this.reports = [];
    this.emit();
  }

  clearOutput() { this.text = ''; this.log = []; this.reports = []; this.emit(); }

  setLayers(layers, parsed) { this.layers = layers; if (parsed) this.parsed = parsed; this.emit(); }
  setHost(host) { this.host = host; this.emit(); }

  // ------------- 状態 -------------

  activeLayers() {
    const s = new Set([0]);
    for (const [l, c] of this.layerCounts) if (c > 0) s.add(l);
    for (const l of this.toggled) s.add(l);
    for (const l of this.sticky) s.add(l);
    if (this.mouseActive && this.mouseLayer != null) s.add(this.mouseLayer);
    return [...s].filter((l) => l < this.layers.length).sort((a, b) => a - b);
  }

  topLayer() { const a = this.activeLayers(); return a[a.length - 1]; }

  currentMods() {
    let m = this.stickyMods;
    for (const [bit, c] of this.heldMods) if (c > 0) m |= bit;
    return m;
  }

  /** そのキー位置で今有効な binding（透過を解決） */
  resolve(pos) {
    const act = this.activeLayers();
    for (let i = act.length - 1; i >= 0; i--) {
      const b = this.layers[act[i]]?.[pos];
      if (b && b.behavior !== 'trans') return { binding: b, layer: act[i] };
    }
    return { binding: { behavior: 'none', params: [] }, layer: 0 };
  }

  snapshot() {
    return {
      activeLayers: this.activeLayers(),
      topLayer: this.topLayer(),
      mods: this.currentMods(),
      stickyMods: this.stickyMods,
      pressed: [...this.pressed.keys()],
      pendingPos: this.pending ? this.pending.pos : null,
      queued: this.queue.filter((e) => e.type === 'press').map((e) => e.pos),
      text: this.text,
      log: this.log,
      reports: this.reports,
      capsWord: this.capsWord,
      mouseActive: this.mouseActive,
    };
  }

  emit() { this.onChange(this.snapshot()); }

  addLog(msg, kind = 'info') {
    this.log.push({ t: Date.now(), msg, kind });
    if (this.log.length > 300) this.log.shift();
  }

  // ------------- レイヤー操作 -------------

  layerOn(l) { this.layerCounts.set(l, (this.layerCounts.get(l) || 0) + 1); }
  layerOff(l) { this.layerCounts.set(l, Math.max(0, (this.layerCounts.get(l) || 0) - 1)); }
  layerName(l) {
    const L = this.parsed?.layers?.[l];
    const nm = L ? (L.displayName || L.nodeName) : '';
    return `レイヤー${l}${nm ? '「' + nm + '」' : ''}`;
  }

  setMouseActive(on) {
    this.mouseActive = !!on;
    if (this.mouseLayer != null) this.addLog(on ? `トラックボール操作中 → ${this.layerName(this.mouseLayer)} が有効` : 'トラックボール停止', 'layer');
    this.emit();
  }

  // ------------- PC 側（ホスト） -------------

  hostDown(usage, implicitMods = 0, maskMods = 0) {
    const bit = MOD_USAGE_BIT[usage];
    if (bit) {
      this.heldMods.set(bit, (this.heldMods.get(bit) || 0) + 1);
      this.reports.push({ label: modsToNames(bit)[0] + ' 押下', kind: 'mod' });
      this.trimReports();
      return;
    }
    const mods = ((this.currentMods() & ~maskMods) | implicitMods);
    const key = keyByUsage(usage);
    this.lastKey = { usage, implicitMods };
    if (this.stickyMods) this.stickyMods = 0;
    this.output(key, usage, mods);
  }

  hostUp(usage) {
    const bit = MOD_USAGE_BIT[usage];
    if (bit) {
      this.heldMods.set(bit, Math.max(0, (this.heldMods.get(bit) || 0) - 1));
      this.reports.push({ label: modsToNames(bit)[0] + ' 離す', kind: 'mod' });
      this.trimReports();
    }
  }

  trimReports() { if (this.reports.length > 200) this.reports.splice(0, this.reports.length - 200); }

  output(key, usage, mods) {
    const host = this.host;
    // Caps Word
    let shift = !!(mods & SHIFT_MASK);
    if (this.capsWord && key) {
      if (key.cat === 'alpha') shift = true;
      else if (!(key.name === 'MINUS' || key.name === 'BSPC' || key.cat === 'num' || (key.name === 'INT1' && host === 'jis'))) this.capsWord = false;
    }
    const ctrlLike = mods & (CTRL_MASK | ALT_MASK | GUI_MASK);
    const label = keyLabel({ mods: (mods & ~SHIFT_MASK) | (shift ? SHIFT_MASK : 0), usage, key }, host).main;
    let produced = '';
    if (key && !ctrlLike) {
      if (producesText(key, host)) {
        let ch = charFor(key, shift, host);
        if (key.cat === 'alpha') ch = (shift !== this.capsLock) ? key.us.toUpperCase() : key.us;
        produced = ch || '';
      } else if (key.name === 'SPACE') produced = ' ';
      else if (key.name === 'RETURN' || key.name === 'KP_ENTER') produced = '\n';
      else if (key.name === 'TAB') produced = '\t';
      else if (key.cat === 'kp' && /^[0-9.+\-*/=,]$/.test(key.us)) produced = key.us;
      else if (key.name === 'BACKSPACE') { this.text = this.text.slice(0, -1); }
      else if (key.name === 'CAPSLOCK' && host === 'us') this.capsLock = !this.capsLock;
      else if (key.name === 'CAPSLOCK' && host === 'jis' && shift) this.capsLock = !this.capsLock;
    }
    if (produced) this.text += produced;
    if (this.text.length > 5000) this.text = this.text.slice(-5000);
    this.reports.push({
      label,
      out: produced ? (produced === '\n' ? '⏎' : produced === ' ' ? '␣' : produced === '\t' ? '⇥' : produced) : '',
      kind: ctrlLike ? 'shortcut' : produced ? 'text' : 'key',
    });
    this.trimReports();
  }

  tapKey(expr) {
    const p = parseKeyExpr(expandDefines(expr, this.parsed?.defines));
    if (!p) { this.addLog(`不明なキー: ${expr}`, 'warn'); return; }
    this.hostDown(p.usage, p.mods & ~(MOD_USAGE_BIT[p.usage] || 0));
    this.hostUp(p.usage);
  }

  // ------------- 入力 -------------

  press(pos) {
    if (this.pressed.has(pos) || this.queue.some((e) => e.type === 'press' && e.pos === pos && !this.queue.some((f) => f.type === 'release' && f.pos === pos))) return;
    if (this.pending) {
      this.queue.push({ type: 'press', pos, t: this.now() });
      this.onOtherPress();
      this.emit();
      return;
    }
    this.doPress(pos);
    this.emit();
  }

  release(pos) {
    if (this.pending) {
      if (pos === this.pending.pos) {
        this.decide('tap', true);
        this.doRelease(pos);
        this.drainQueue();
      } else {
        this.queue.push({ type: 'release', pos, t: this.now() });
        this.onOtherRelease(pos);
      }
      this.emit();
      return;
    }
    this.doRelease(pos);
    this.emit();
  }

  onOtherPress() {
    const p = this.pending;
    if (!p) return;
    if (p.cfg.flavor === 'hold-preferred' || p.cfg.flavor === 'tap-unless-interrupted') {
      this.decide('hold');
      this.drainQueue();
    }
  }

  onOtherRelease(pos) {
    const p = this.pending;
    if (!p) return;
    if (p.cfg.flavor === 'balanced' && this.queue.some((e) => e.type === 'press' && e.pos === pos)) {
      this.decide('hold');
      this.drainQueue();
    }
  }

  drainQueue() {
    while (this.queue.length && !this.pending) {
      const e = this.queue.shift();
      if (e.type === 'press') this.doPress(e.pos);
      else this.doRelease(e.pos);
    }
  }

  doRelease(pos) {
    const st = this.pressed.get(pos);
    if (!st) return;
    this.pressed.delete(pos);
    try { st.release && st.release(); } catch (e) { this.addLog('エラー: ' + e.message, 'warn'); }
    // スティッキーレイヤーは「別のキーを 1 回押して離した」ら解除
    if (!st.isSticky && this.sticky.size) {
      for (const l of this.sticky) this.addLog(`ワンショット ${this.layerName(l)} 解除`, 'layer');
      this.sticky.clear();
    }
  }

  doPress(pos) {
    const { binding, layer } = this.resolve(pos);
    const st = { release: null, binding, layer };
    this.pressed.set(pos, st);
    this.execute(binding, pos, st);
  }

  /**
   * binding を実行（押下）。st.release に離したときの処理を入れる。
   */
  execute(b, pos, st, depth = 0) {
    if (depth > 8) { this.addLog('動作の入れ子が深すぎます', 'warn'); return; }
    const defines = this.parsed?.defines;
    const params = b.params.map((p) => expandDefines(p, defines));
    const name = b.behavior;
    const behaviors = this.parsed?.behaviors || {};
    const custom = behaviors[name];
    const chain = (fn) => { const prev = st.release; st.release = () => { fn(); prev && prev(); }; };
    const layerNum = (s) => parseInt(s);

    // hold-tap（lt / mt / 自作）
    const ht = holdTapConfig(this.parsed, name);
    if (ht) {
      let holdB, tapB;
      if (custom && custom.bindings.length >= 2) {
        holdB = { behavior: custom.bindings[0].behavior, params: [...custom.bindings[0].params, params[0]].filter((x) => x != null) };
        tapB = { behavior: custom.bindings[1].behavior, params: [...custom.bindings[1].params, params[1]].filter((x) => x != null) };
      } else if (name === 'lt') {
        holdB = { behavior: 'mo', params: [params[0]] };
        tapB = { behavior: 'kp', params: [params[1]] };
      } else {
        holdB = { behavior: 'kp', params: [params[0]] };
        tapB = { behavior: 'kp', params: [params[1]] };
      }
      const now = this.now();
      const last = this.lastTap.get(pos);
      if (ht.quickTap > 0 && last != null && now - last < ht.quickTap) {
        this.addLog(`クイックタップ（${ht.quickTap}ms 以内の再押下）→ タップ扱いで押しっぱなし`, 'ht');
        this.execute(tapB, pos, st, depth + 1);
        return;
      }
      const pending = { pos, cfg: ht, holdB, tapB, st, depth, start: now };
      pending.timer = this.setTimer(() => {
        if (this.pending !== pending) return;
        this.decide(ht.flavor === 'tap-unless-interrupted' ? 'tap' : 'hold', false, '時間経過');
        this.drainQueue();
        this.emit();
      }, ht.tappingTerm);
      this.pending = pending;
      return;
    }

    if (custom && custom.compatible === 'zmk,behavior-mod-morph') {
      const mask = parseModMask(custom.mods);
      const keep = parseModMask(custom.keepMods);
      const cur = this.currentMods();
      const morph = (cur & mask) !== 0;
      const chosen = custom.bindings[morph ? 1 : 0] || { behavior: 'none', params: [] };
      if (morph) this.addLog(`${name}: Shift などが押されているので「${chosen.behavior} ${chosen.params.join(' ')}」に変化`, 'morph');
      const masked = morph ? (cur & mask & ~keep) : 0;
      // 変化後のキーを送る間だけ、条件の修飾キーを外す
      if (masked && (chosen.behavior === 'kp')) {
        const p = parseKeyExpr(expandDefines(chosen.params[0], defines));
        if (p) {
          this.hostDown(p.usage, p.mods, masked);
          chain(() => this.hostUp(p.usage));
          return;
        }
      }
      this.execute(chosen, pos, st, depth + 1);
      return;
    }

    if (custom && /zmk,behavior-macro/.test(custom.compatible)) {
      this.runMacro(custom, params, pos, st, depth);
      return;
    }

    switch (name) {
      case 'kp': {
        const p = parseKeyExpr(params[0]);
        if (!p) { this.addLog(`不明なキー: ${b.params[0]}`, 'warn'); return; }
        const implicit = p.mods & ~(MOD_USAGE_BIT[p.usage] || 0);
        this.hostDown(p.usage, implicit);
        // 修飾付きキー（LS(A) など）は修飾も一緒に送る
        chain(() => this.hostUp(p.usage));
        return;
      }
      case 'trans': case 'none': return;
      case 'mo': {
        const l = layerNum(params[0]);
        this.layerOn(l);
        this.addLog(`${this.layerName(l)} ON（押している間）`, 'layer');
        chain(() => { this.layerOff(l); this.addLog(`${this.layerName(l)} OFF`, 'layer'); });
        return;
      }
      case 'tog': {
        const l = layerNum(params[0]);
        if (this.toggled.has(l)) { this.toggled.delete(l); this.addLog(`${this.layerName(l)} 固定解除`, 'layer'); }
        else { this.toggled.add(l); this.addLog(`${this.layerName(l)} 固定ON`, 'layer'); }
        return;
      }
      case 'to': {
        const l = layerNum(params[0]);
        this.toggled.clear(); this.layerCounts.clear(); this.sticky.clear();
        if (l !== 0) this.toggled.add(l);
        this.addLog(`${this.layerName(l)} に切り替え（ほかのレイヤーは解除）`, 'layer');
        return;
      }
      case 'sl': {
        const l = layerNum(params[0]);
        this.sticky.add(l);
        st.isSticky = true;
        this.addLog(`ワンショット ${this.layerName(l)}（次の 1 キーだけ）`, 'layer');
        return;
      }
      case 'sk': {
        const bit = modBitFromExpr(params[0]);
        this.stickyMods |= bit;
        this.addLog(`ワンショット修飾 ${modsToNames(bit).join('+')}（次の 1 キーだけ）`, 'mod');
        return;
      }
      case 'caps_word': {
        this.capsWord = !this.capsWord;
        this.addLog(`Caps Word ${this.capsWord ? 'ON（単語の間だけ大文字）' : 'OFF'}`, 'mod');
        return;
      }
      case 'key_repeat': {
        if (this.lastKey) {
          const { usage, implicitMods } = this.lastKey;
          this.hostDown(usage, implicitMods);
          chain(() => this.hostUp(usage));
        }
        return;
      }
      case 'bt': this.addLog(btDescribe(params), 'system'); return;
      case 'out': this.addLog(`出力先: ${({ OUT_USB: 'USB', OUT_BLE: 'Bluetooth', OUT_TOG: 'USB/Bluetooth 切替' })[params[0]] || params[0]}`, 'system'); return;
      case 'mkp': {
        const nm = mouseButtonName(params[0]);
        this.addLog(`マウス ${nm} 押下`, 'mouse');
        this.reports.push({ label: `🖱 ${nm}`, kind: 'mouse' });
        chain(() => this.addLog(`マウス ${nm} 離す`, 'mouse'));
        return;
      }
      case 'msc': {
        const dir = { SCRL_UP: '↑', SCRL_DOWN: '↓', SCRL_LEFT: '←', SCRL_RIGHT: '→' }[b.params[0]] || b.params.join(' ');
        this.addLog(`マウスのスクロール ${dir}`, 'mouse');
        this.reports.push({ label: `🖱 スクロール${dir}`, kind: 'mouse' });
        return;
      }
      case 'mmv': this.addLog(`マウス移動 ${params.join(' ')}`, 'mouse'); return;
      case 'bootloader': this.addLog('ブートローダーに入る（書き込みモード）', 'system'); return;
      case 'sys_reset': this.addLog('キーボードを再起動', 'system'); return;
      case 'soft_off': this.addLog('電源オフ', 'system'); return;
      case 'studio_unlock': this.addLog('ZMK Studio のロック解除', 'system'); return;
      case 'rgb_ug': case 'bl': case 'ext_power': this.addLog(`${name} ${params.join(' ')}`, 'system'); return;
      default:
        this.addLog(`シミュレーター未対応の動作: &${name} ${params.join(' ')}`, 'warn');
    }
  }

  runMacro(custom, params, pos, st, depth) {
    let mode = 'tap';
    let paramNext = null;
    const pressedInMacro = [];
    for (const raw of custom.bindings) {
      const b = { behavior: raw.behavior, params: [...raw.params] };
      if (b.behavior === 'macro_tap') { mode = 'tap'; continue; }
      if (b.behavior === 'macro_press') { mode = 'press'; continue; }
      if (b.behavior === 'macro_release') { mode = 'release'; continue; }
      if (b.behavior === 'macro_pause_for_release') { continue; }
      if (/^macro_(wait_time|tap_time)$/.test(b.behavior)) continue;
      if (b.behavior === 'macro_param_1to1') { paramNext = [0, 0]; continue; }
      if (b.behavior === 'macro_param_2to1') { paramNext = [1, 0]; continue; }
      if (b.behavior === 'macro_param_1to2') { paramNext = [0, 1]; continue; }
      if (b.behavior === 'macro_param_2to2') { paramNext = [1, 1]; continue; }
      if (paramNext) {
        const [from, to] = paramNext;
        if (params[from] != null) b.params[to] = params[from];
        paramNext = null;
      }
      const sub = { release: null };
      if (mode === 'release') {
        const idx = pressedInMacro.findIndex((x) => x.b.behavior === b.behavior && x.b.params.join() === b.params.join());
        if (idx >= 0) { const x = pressedInMacro.splice(idx, 1)[0]; x.sub.release && x.sub.release(); }
        continue;
      }
      this.execute(b, pos, sub, depth + 1);
      if (mode === 'tap') sub.release && sub.release();
      else pressedInMacro.push({ b, sub });
    }
    this.addLog(`マクロ ${custom.label} を実行`, 'macro');
    st.release = () => { for (const x of pressedInMacro) x.sub.release && x.sub.release(); };
  }

  /** エンコーダーを回す（dir: 1 = 時計回り, -1 = 反時計回り） */
  rotate(index, dir, sensorLayers) {
    const act = this.activeLayers();
    let b = null;
    let layer = 0;
    for (let i = act.length - 1; i >= 0; i--) {
      const x = sensorLayers?.[act[i]]?.[index];
      // ZMK ではエンコーダーの &trans / &none はどちらも下のレイヤーへ素通りする
      if (x && x.behavior !== 'trans' && x.behavior !== 'none') { b = x; layer = act[i]; break; }
    }
    const dirName = dir > 0 ? '時計回り' : '反時計回り';
    if (!b || b.behavior === 'none') { this.addLog(`エンコーダー${dirName}: 何もしない`, 'info'); this.emit(); return; }
    const defines = this.parsed?.defines;
    const st = { release: null };
    const run = (binding) => {
      this.execute(binding, -1 - index, st);
      if (st.release) { const r = st.release; st.release = null; r(); }
    };
    if (b.behavior === 'inc_dec_kp') {
      run({ behavior: 'kp', params: [b.params[dir > 0 ? 0 : 1]] });
    } else {
      const c = this.parsed?.behaviors?.[b.behavior];
      if (c && /sensor-rotate/.test(c.compatible) && c.bindings.length >= 2) {
        const src = c.bindings[dir > 0 ? 0 : 1];
        const extra = c.compatible === 'zmk,behavior-sensor-rotate-var' ? [b.params[dir > 0 ? 0 : 1]] : [];
        run({ behavior: src.behavior, params: [...src.params, ...extra].filter((x) => x != null).map((p) => expandDefines(p, defines)) });
      } else {
        this.addLog(`シミュレーター未対応のエンコーダー動作: &${b.behavior}`, 'warn');
      }
    }
    this.addLog(`エンコーダーを${dirName}（L${layer}）`, 'info');
    this.emit();
  }

  decide(kind, byRelease = false, reason = '') {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.clearTimer(p.timer);
    const why = reason || (byRelease ? '長押し時間より前に離した' : 'ほかのキーが押された');
    this.addLog(`${kind === 'hold' ? '長押し' : 'タップ'}と判定（${why}）`, 'ht');
    const target = kind === 'hold' ? p.holdB : p.tapB;
    if (kind === 'tap') this.lastTap.set(p.pos, this.now());
    else this.lastTap.delete(p.pos);
    this.execute(target, p.pos, p.st, p.depth + 1);
  }
}

function btDescribe(params) {
  const [cmd, n] = params;
  const map = {
    BT_SEL: `Bluetooth: 接続先 ${n} を選択`,
    BT_CLR: 'Bluetooth: 今の接続先のペアリングを削除',
    BT_CLR_ALL: 'Bluetooth: すべてのペアリングを削除',
    BT_NXT: 'Bluetooth: 次の接続先',
    BT_PRV: 'Bluetooth: 前の接続先',
    BT_DISC: `Bluetooth: 接続先 ${n} を切断`,
  };
  return map[cmd] || `Bluetooth: ${params.join(' ')}`;
}

export function mouseButtonName(p) {
  return ({ MB1: '左クリック', LCLK: '左クリック', MB2: '右クリック', RCLK: '右クリック', MB3: '中クリック', MCLK: '中クリック', MB4: '戻る', MB5: '進む' })[p] || p;
}

export { MOD_BITS, keyByName };
