import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseKeymap } from '../js/dts.js';
import { StudioDevice } from '../js/studio.js';
import {
  matchBehaviors, encodeBinding, decodeBinding, compareKeymaps, encodeKey, decodeKey,
} from '../js/studio-map.js';
import { createFakeDevice, FAKE_BEHAVIORS } from './fake-device.mjs';

const TEXT = fs.readFileSync(new URL('./fixture.keymap', import.meta.url), 'utf8');

function setup() {
  const parsed = parseKeymap(TEXT);
  const match = matchBehaviors(FAKE_BEHAVIORS, parsed);
  const ctx = { parsed, match, layerIds: [0, 1, 2, 3], layerIndexById: new Map([[0, 0], [1, 1], [2, 2], [3, 3]]) };
  return { parsed, match, ctx };
}

test('キーのエンコード（ZMK の keys.h と同じ値）', () => {
  assert.equal(encodeKey('Q'), 0x00070014);
  assert.equal(encodeKey('LS(LG(S))'), 0x0a070016);
  assert.equal(encodeKey('AT'), 0x0207001f); // LS(N2)
  assert.equal(encodeKey('LSHIFT'), 0x000700e1);
  assert.equal(encodeKey('C_VOL_UP'), 0x000c00e9);
  assert.equal(decodeKey(0x0a070016), 'LS(LG(S))');
  assert.equal(decodeKey(0x000c00e9), 'C_VOLUME_UP');
  assert.equal(decodeKey(0x00070089), 'INTERNATIONAL_3');
});

test('本体の動作と .keymap の動作を対応づける', () => {
  const { match } = setup();
  assert.equal(match.byId.get(1).label, 'kp');
  assert.equal(match.byId.get(11).label, 'mm2'); // ノード名で一致
  assert.equal(match.byId.get(12).label, 'hl'); // hold_layer ノード → ラベル hl
});

test('binding のエンコード・デコード', () => {
  const { ctx } = setup();
  const cases = [
    [{ behavior: 'kp', params: ['Q'] }, { behaviorId: 1, param1: 0x00070014, param2: 0 }],
    [{ behavior: 'lt', params: ['1', 'SPACE'] }, { behaviorId: 2, param1: 1, param2: 0x0007002c }],
    [{ behavior: 'mt', params: ['LALT', 'ESC'] }, { behaviorId: 3, param1: 0x000700e2, param2: 0x00070029 }],
    [{ behavior: 'bt', params: ['BT_SEL', '1'] }, { behaviorId: 7, param1: 3, param2: 1 }],
    [{ behavior: 'bt', params: ['BT_CLR'] }, { behaviorId: 7, param1: 0, param2: 0 }],
    [{ behavior: 'mkp', params: ['MB2'] }, { behaviorId: 10, param1: 2, param2: 0 }],
    [{ behavior: 'trans', params: [] }, { behaviorId: 5, param1: 0, param2: 0 }],
    [{ behavior: 'mm2', params: [] }, { behaviorId: 11, param1: 0, param2: 0 }],
    [{ behavior: 'hl', params: ['1', 'INT_MUHENKAN'] }, { behaviorId: 12, param1: 1, param2: 0x0007008b }],
  ];
  for (const [b, v] of cases) {
    const e = encodeBinding(b, ctx);
    assert.ok(e.ok, JSON.stringify(b) + ' ' + e.error);
    assert.deepEqual(e.value, v, JSON.stringify(b));
    const d = decodeBinding(v, ctx);
    assert.ok(d.ok);
    assert.equal(encodeBinding(d.value, ctx).value.param1, v.param1);
  }
  // define 経由（JP_AT = LEFT_BRACKET）
  assert.equal(encodeBinding({ behavior: 'kp', params: ['JP_AT'] }, ctx).value.param1, 0x0007002f);
  // 本体にない動作
  const ctx2 = { ...ctx, match: matchBehaviors(FAKE_BEHAVIORS.filter((b) => b.id !== 11), ctx.parsed) };
  const miss = encodeBinding({ behavior: 'mm2', params: [] }, ctx2);
  assert.equal(miss.ok, false);
  assert.match(miss.error, /ビルド/);
  // レイヤー ID の変換（本体側で並べ替えられている場合）
  const ctx3 = { ...ctx, layerIds: [0, 3, 1, 2], layerIndexById: new Map([[0, 0], [3, 1], [1, 2], [2, 3]]) };
  assert.equal(encodeBinding({ behavior: 'mo', params: ['1'] }, ctx3).value.param1, 3);
  assert.deepEqual(decodeBinding({ behaviorId: 4, param1: 3, param2: 0 }, ctx3).value, { behavior: 'mo', params: ['1'] });
});

function deviceLayersFromApp(parsed, ctx) {
  return parsed.layers.map((l) => ({ name: l.displayName, bindings: l.bindings.map((b) => encodeBinding(b, ctx).value) }));
}

test('偽の本体: 接続・読み込み・差分・書き込み・保存', async () => {
  const { parsed, ctx } = setup();
  const fake = createFakeDevice({ layers: deviceLayersFromApp(parsed, ctx) });
  const dev = new StudioDevice(fake.transport);
  await dev.init();
  assert.equal(dev.info.name, 'zonkey');
  assert.equal(dev.behaviors.length, FAKE_BEHAVIORS.length);
  assert.equal(dev.keymap.layers.length, 4);

  const match = matchBehaviors(dev.behaviors, parsed);
  const c = { parsed, match, layerIds: dev.layerIds(), layerIndexById: dev.layerIndexById() };
  const app = parsed.layers.map((l) => ({ displayName: l.displayName, bindings: l.bindings.map((b) => ({ ...b })) }));
  assert.equal(compareKeymaps(app, dev.keymap, c).diffs.length, 0);

  app[0].bindings[0] = { behavior: 'kp', params: ['LC(Z)'] };
  app[1].bindings[1] = { behavior: 'trans', params: [] };
  const cmp = compareKeymaps(app, dev.keymap, c);
  assert.equal(cmp.diffs.length, 2);
  for (const d of cmp.diffs) await dev.setBinding(d.layer, d.pos, d.enc);
  assert.equal(fake.state.layers[0].bindings[0].param1, 0x0107001d);
  assert.equal(fake.state.unsaved, true);
  await dev.save();
  assert.equal(fake.state.unsaved, false);
  await dev.loadKeymap();
  assert.equal(compareKeymaps(app, dev.keymap, c).diffs.length, 0);

  // 本体 → アプリ
  fake.state.layers[2].bindings[5] = { behaviorId: 1, param1: 0x02070004, param2: 0 };
  await dev.loadKeymap();
  const d = decodeBinding(dev.keymap.layers[2].bindings[5], c);
  assert.deepEqual(d.value, { behavior: 'kp', params: ['LS(A)'] });

  await dev.setLayerName(1, 'すうじ');
  assert.equal(fake.state.layers[1].name, 'すうじ');
  dev.disconnect();
});

test('偽の本体: ロック中は解除を待つ', async () => {
  const { parsed, ctx } = setup();
  const fake = createFakeDevice({ layers: deviceLayersFromApp(parsed, ctx), locked: true });
  let notified = null;
  const dev = new StudioDevice(fake.transport, { onNotify: (n) => { notified = n; } });
  await dev.init();
  assert.equal(dev.lockState, 0);
  assert.equal(dev.keymap, null);
  await assert.rejects(dev.loadKeymap(), /ロック/);
  await fake.unlock();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(dev.lockState, 1);
  assert.ok(notified?.core);
  await dev.loadAll();
  assert.equal(dev.keymap.layers.length, 4);
  dev.disconnect();
});
