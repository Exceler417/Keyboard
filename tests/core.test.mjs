import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseKeymap, serializeKeymap, bindingToString, holdTapConfig } from '../js/dts.js';
import { ROW_SIZES, ZONKEY_LAYOUT, PC_KEYMAP } from '../js/layout.js';
import { keyLabel, parseKeyExpr, charTable } from '../js/keycodes.js';
import { Simulator, guessMouseLayer } from '../js/sim.js';
import { describeBinding } from '../js/describe.js';
import { lintKeymap } from '../js/lint.js';

const TEXT = fs.readFileSync(new URL('./fixture.keymap', import.meta.url), 'utf8');
const editable = (p) => p.layers.map((l, i) => ({ origIndex: i, displayName: l.displayName, bindings: l.bindings.map((b) => ({ ...b, params: [...b.params] })), sensorBindings: l.sensorBindings }));

function makeSim(parsed, host = 'jis') {
  let t = 0;
  const timers = [];
  const sim = new Simulator({
    parsed, layers: parsed.layers.map((l) => l.bindings), host,
    now: () => t,
    setTimer: (fn, ms) => { const o = { at: t + ms, fn }; timers.push(o); return o; },
    clearTimer: (o) => { if (o) o.at = Infinity; },
  });
  sim.mouseLayer = guessMouseLayer(parsed, parsed.layers.length);
  const adv = (ms) => { t += ms; for (const o of timers.slice()) if (o.at <= t) { o.at = Infinity; o.fn(); } };
  const tap = (pos, ms = 50) => { sim.press(pos); adv(ms); sim.release(pos); adv(10); };
  return { sim, adv, tap };
}

test('物理配列と PC 割り当ては 43 キー', () => {
  assert.equal(ZONKEY_LAYOUT.length, 43);
  assert.equal(PC_KEYMAP.length, 43);
  assert.equal(ROW_SIZES.flat().reduce((a, b) => a + b, 0), 43);
});

test('keymap を解析できる', () => {
  const p = parseKeymap(TEXT);
  assert.deepEqual(p.errors, []);
  assert.equal(p.layers.length, 4);
  assert.deepEqual(p.layers.map((l) => l.bindings.length), [43, 43, 43, 43]);
  assert.equal(p.layers[1].displayName, '数字');
  assert.equal(bindingToString(p.layers[0].bindings[15]), '&kp LS(LG(S))');
  assert.equal(bindingToString(p.layers[0].bindings[39]), '&hl 1 INT_MUHENKAN');
  assert.equal(p.defines.MOUSE, '3');
  assert.ok(p.behaviors.mm2 && p.behaviors.hl);
  assert.deepEqual(holdTapConfig(p, 'mt'), { flavor: 'balanced', tappingTerm: 200, quickTap: 0, hold: 'kp', tap: 'kp' });
  assert.equal(holdTapConfig(p, 'hl').tappingTerm, 300);
  assert.equal(guessMouseLayer(p, 4), 3);
});

test('変更なしなら完全に同じテキストを書き出す', () => {
  const p = parseKeymap(TEXT);
  assert.equal(serializeKeymap(p, editable(p), ROW_SIZES), TEXT);
});

test('キー変更・名前変更・レイヤー追加削除を書き出せる', () => {
  const p = parseKeymap(TEXT);
  const layers = editable(p);
  layers[0].bindings[0] = { behavior: 'kp', params: ['LC(C)'] };
  layers[0].displayName = 'ベース';
  layers[1].displayName = '数字と矢印';
  layers.splice(3, 1);
  layers.push({ origIndex: null, displayName: '新規', bindings: Array.from({ length: 43 }, () => ({ behavior: 'trans', params: [] })), sensorBindings: null });
  const out = serializeKeymap(p, layers, ROW_SIZES);
  const p2 = parseKeymap(out);
  assert.deepEqual(p2.errors, []);
  assert.deepEqual(p2.layers.map((l) => l.displayName), ['ベース', '数字と矢印', '', '新規']);
  assert.equal(bindingToString(p2.layers[0].bindings[0]), '&kp LC(C)');
  assert.equal(p2.layers[0].bindings.length, 43);
  assert.ok(out.includes('/* コメント { } も無視されること */'));
  assert.ok(out.includes('#define JP_AT LEFT_BRACKET // @'));
});

test('JIS / US のラベル', () => {
  assert.equal(keyLabel('SQT', 'jis').main, ':');
  assert.equal(keyLabel('SQT', 'us').main, "'");
  assert.equal(keyLabel('AT', 'jis').main, '"');
  assert.equal(keyLabel('LBKT', 'jis').main, '@');
  assert.equal(keyLabel('LS(LG(S))', 'jis').main, 'Win+Shift+S');
  assert.equal(keyLabel('INT_HENKAN', 'jis').main, '変換');
  assert.equal(parseKeyExpr('0x89').key.name, 'INTERNATIONAL_3');
  const at = charTable('jis').find((c) => c.ch === '@');
  assert.equal(at.expr, 'LEFT_BRACKET');
  const dq = charTable('jis').find((c) => c.ch === '"');
  assert.equal(dq.expr, 'LS(N2)');
});

test('説明文', () => {
  const p = parseKeymap(TEXT);
  const ctx = { parsed: p, host: 'jis', layerNames: ['base', '数字', 'fn', 'mouse'] };
  const d = describeBinding({ behavior: 'lt', params: ['1', 'SPACE'] }, ctx);
  assert.equal(d.tap, 'Space');
  assert.equal(d.hold, 'L1');
  assert.match(d.desc, /レイヤー1「数字」/);
  const m = describeBinding({ behavior: 'mm2', params: [] }, ctx);
  assert.equal(m.tap, '2');
  assert.equal(m.shift, '@');
});

test('シミュレーター: 通常入力とタップ／長押し', () => {
  const p = parseKeymap(TEXT);
  const { sim, adv, tap } = makeSim(p);
  tap(0); tap(1); tap(21);
  assert.equal(sim.text, 'qw:');
  // lt 1 SPACE: タップ
  tap(38);
  assert.equal(sim.text, 'qw: ');
  // lt 1 SPACE: 長押し（時間経過）→ L1 の #0 は 1
  sim.press(38); adv(250); tap(0); sim.release(38); adv(10);
  assert.equal(sim.text, 'qw: 1');
  assert.deepEqual(sim.activeLayers(), [0]);
});

test('シミュレーター: hold-preferred は他のキーで即長押し', () => {
  const p = parseKeymap(TEXT);
  const { sim, adv, tap } = makeSim(p);
  // &hl 1 INT_MUHENKAN（hold-preferred, 300ms）
  sim.press(39); adv(20); tap(2); sim.release(39);
  assert.equal(sim.text, '3');
});

test('シミュレーター: tap-preferred（lt）は時間内なら他キーを押してもタップ', () => {
  const p = parseKeymap(TEXT);
  const { sim, adv } = makeSim(p);
  sim.press(38); adv(20); sim.press(0); adv(20); sim.release(0); adv(20); sim.release(38);
  assert.equal(sim.text, ' q');
});

test('シミュレーター: balanced（mt）は他キーを押して離すと長押し', () => {
  const p = parseKeymap(TEXT);
  const { sim, adv } = makeSim(p);
  sim.press(36); adv(20); sim.press(25); adv(20); sim.release(25); adv(10); sim.release(36);
  assert.equal(sim.text, '');
  assert.equal(sim.reports.at(-2).label, 'Alt+C');
});

test('シミュレーター: mod-morph は JIS で Shift 時に @', () => {
  const p = parseKeymap(TEXT);
  const { sim, adv, tap } = makeSim(p);
  sim.press(38); adv(250); tap(1); sim.press(22); tap(1); sim.release(22); sim.release(38);
  assert.equal(sim.text, '2@');
});

test('シミュレーター: tog と to、マウスレイヤー', () => {
  const p = parseKeymap(TEXT);
  const { sim, adv, tap } = makeSim(p);
  sim.press(38); adv(250); tap(42); sim.release(38); adv(10); // L1 の #42 = tog 2
  assert.deepEqual(sim.activeLayers(), [0, 2]);
  tap(0);
  assert.deepEqual(sim.log.at(-1).msg.startsWith('Bluetooth'), true);
  tap(42); // L2 の #42 = to 0
  assert.deepEqual(sim.activeLayers(), [0]);
  sim.setMouseActive(true);
  tap(18);
  assert.match(sim.log.map((l) => l.msg).join(), /左クリック/);
});

test('チェック: 不明な動作・存在しないレイヤー・使われないレイヤー', () => {
  const p = parseKeymap(TEXT);
  const layers = editable(p);
  layers[0].bindings[0] = { behavior: 'foo', params: [] };
  layers[0].bindings[1] = { behavior: 'mo', params: ['9'] };
  layers[0].bindings[37] = { behavior: 'kp', params: ['INT_HENKAN'] };
  layers[1].bindings[42] = { behavior: 'trans', params: [] };
  const r = lintKeymap({ parsed: p, layers, keyCount: 43, host: 'jis', mouseLayer: 3, positionName: (i) => `#${i}` });
  const msgs = r.map((x) => x.level + ':' + x.msg).join('\n');
  assert.match(msgs, /error:.*&foo/);
  assert.match(msgs, /error:.*レイヤー 9/);
  assert.match(msgs, /warn:レイヤー2 に切り替えるキー/);
  assert.match(msgs, /info:.*SQT.*「:」/);
});
