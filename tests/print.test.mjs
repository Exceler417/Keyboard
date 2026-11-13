import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseKeymap } from '../js/dts.js';
import { layerSvg, legendSvg, layerActivators, customBehaviorRows } from '../js/print.js';

const TEXT = fs.readFileSync(new URL('./fixture.keymap', import.meta.url), 'utf8');

test('PDF 用の SVG を作れる', () => {
  const p = parseKeymap(TEXT);
  const layers = p.layers.map((l) => ({ bindings: l.bindings, sensorBindings: l.sensorBindings, displayName: l.displayName }));
  const names = ['base', '数字', 'fn', 'mouse'];
  const base = { layers, parsed: p, host: 'jis', names, mono: false, showTrans: true, ball: { scrollLayers: [1], snipeLayers: [], automouseLayer: 3 }, mouseLayer: 3 };
  const s0 = layerSvg({ ...base, layerIdx: 0 });
  assert.match(s0, /^<svg /);
  assert.equal((s0.match(/<rect /g) || []).length, 43);
  assert.match(s0, />Q</);
  assert.match(s0, />:</); // JIS では SQT が「:」
  const s1 = layerSvg({ ...base, layerIdx: 1 });
  assert.match(s1, />スクロール</); // トラックボールの動き
  assert.match(s1, /stroke-dasharray/); // 透過キー
  assert.match(s1, /fill="#9aa1b1">A</); // 透過キーにレイヤー0 の内容を薄く表示
  const s1b = layerSvg({ ...base, layerIdx: 1, showTrans: false });
  assert.doesNotMatch(s1b, />A</);
  assert.doesNotMatch(layerSvg({ ...base, layerIdx: 0, mono: true }), /#fff4dc/);
  assert.match(layerSvg({ ...base, layerIdx: 3 }), /マウス/);
  assert.match(legendSvg(false), /レイヤー操作/);
  assert.doesNotMatch(legendSvg(true), /レイヤー操作/);
  // XML として壊れていない（< や & がエスケープされている）
  assert.doesNotMatch(s0.replace(/<\/?[a-z][^>]*>/g, ''), /[<>]/);
});

test('レイヤーの入り方と自作の動作の一覧', () => {
  const p = parseKeymap(TEXT);
  const layers = p.layers.map((l) => ({ bindings: l.bindings }));
  const acts1 = layerActivators(layers, 1, p, ['base', '数字', 'fn', 'mouse']);
  assert.ok(acts1.some((a) => /L0 の「Space」を長押し/.test(a)));
  assert.ok(acts1.some((a) => /無変換/.test(a))); // &hl 1 INT_MUHENKAN
  const acts2 = layerActivators(layers, 2, p, []);
  assert.ok(acts2.some((a) => /固定/.test(a))); // &tog 2
  const rows = customBehaviorRows(p, 'jis', []);
  assert.deepEqual(rows.map((r) => r.name), ['&mm2', '&hl']);
  assert.match(rows[0].desc, /「2」.*「@」/);
});
