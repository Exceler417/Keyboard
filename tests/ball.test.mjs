import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackball, writeTrackball, ballModeForLayer, readConf, writeConf, confChanges, confValue, BALL_CONF } from '../js/ball.js';
import { commitFiles } from '../js/github.js';

const OVERLAY = `#include "zonkey.dtsi"

&spi0 {
    status = "okay";
    cs-gpios = <&gpio0 9 GPIO_ACTIVE_LOW>;

    trackball: trackball@0 {
        status = "okay";
        compatible = "pixart,pmw3610";
        reg = <0>;
        irq-gpios = <&gpio0 2 (GPIO_ACTIVE_LOW | GPIO_PULL_UP)>;
        automouse-layer = <6>;
        scroll-layers = <5>;

    };
};
`;

const CONF = `CONFIG_ZMK_KEYBOARD_NAME="zonkey"
CONFIG_PMW3610=y
CONFIG_PMW3610_CPI=800
# CONFIG_PMW3610_SNIPE_CPI=800
CONFIG_PMW3610_SCROLL_TICK=16
CONFIG_PMW3610_INVERT_SCROLL_X=y
`;

test('overlay のレイヤー設定を読み書きできる', () => {
  const s = readTrackball(OVERLAY);
  assert.deepEqual(s, { found: true, scrollLayers: [5], snipeLayers: [], automouseLayer: 6, ballActions: 0 });
  const out = writeTrackball(OVERLAY, { scrollLayers: [5, 3], snipeLayers: [2], automouseLayer: 6 });
  assert.match(out, /scroll-layers = <3 5>;/);
  assert.match(out, /snipe-layers = <2>;/);
  assert.match(out, /automouse-layer = <6>;/);
  assert.match(out, /cs-gpios = <&gpio0 9 GPIO_ACTIVE_LOW>;/);
  assert.deepEqual(readTrackball(out).snipeLayers, [2]);
  // 空にするとプロパティごと消える（ドライバーの既定値に戻る）
  const off = writeTrackball(out, { scrollLayers: [], snipeLayers: [], automouseLayer: -1 });
  assert.doesNotMatch(off, /scroll-layers|snipe-layers|automouse-layer/);
  assert.deepEqual(readTrackball(off), { found: true, scrollLayers: [], snipeLayers: [], automouseLayer: -1, ballActions: 0 });
  assert.throws(() => writeTrackball('/ { };', { scrollLayers: [] }), /見つかりません/);
  assert.equal(ballModeForLayer(s, 5), 'scroll');
  assert.equal(ballModeForLayer(s, 0), 'move');
});

test('.conf の値を読み書きできる', () => {
  const conf = readConf(CONF);
  assert.equal(conf.PMW3610_CPI, '800');
  assert.equal(conf.PMW3610_SNIPE_CPI, undefined); // コメント行は無視
  const byKey = Object.fromEntries(BALL_CONF.map((i) => [i.key, i]));
  assert.equal(confValue(conf, byKey.PMW3610_SCROLL_TICK), 16);
  assert.equal(confValue(conf, byKey.PMW3610_INVERT_SCROLL_X), true);
  assert.equal(confValue(conf, byKey.PMW3610_INVERT_SCROLL_Y), false);
  const changes = confChanges(conf, { PMW3610_CPI: 1200, PMW3610_SCROLL_TICK: 16, PMW3610_INVERT_SCROLL_Y: true, PMW3610_SNIPE_CPI: 200 });
  assert.deepEqual(changes, { PMW3610_CPI: '1200', PMW3610_INVERT_SCROLL_Y: 'y' });
  const out = writeConf(CONF, changes);
  assert.match(out, /^CONFIG_PMW3610_CPI=1200$/m);
  assert.match(out, /^CONFIG_PMW3610_INVERT_SCROLL_Y=y$/m);
  assert.match(out, /# CONFIG_PMW3610_SNIPE_CPI=800/);
  assert.equal(readConf(out).PMW3610_SCROLL_TICK, '16');
  // null で行を消す
  assert.doesNotMatch(writeConf(out, { PMW3610_INVERT_SCROLL_X: null }), /INVERT_SCROLL_X=/);
});

test('複数ファイルを 1 コミットで保存する（GitHub API の呼び出し順）', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', url.replace('https://api.github.com/repos/me/cfg/git', ''), opts.body ? JSON.parse(opts.body) : null]);
    const body = url.includes('/ref/heads/') ? { object: { sha: 'p1' } }
      : url.endsWith('/commits/p1') ? { tree: { sha: 't0' } }
        : url.endsWith('/trees') ? { sha: 't1' }
          : url.endsWith('/commits') ? { sha: 'c1' } : {};
    return { ok: true, json: async () => body };
  };
  try {
    const r = await commitFiles({ owner: 'me', repo: 'cfg', branch: 'main', token: 'x', message: 'm', files: [{ path: 'a.overlay', text: 'A' }, { path: 'b.conf', text: 'B' }] });
    assert.equal(r.sha, 'c1');
    assert.deepEqual(calls.map((c) => c[0] + ' ' + c[1]), ['GET /ref/heads/main', 'GET /commits/p1', 'POST /trees', 'POST /commits', 'PATCH /refs/heads/main']);
    assert.equal(calls[2][2].base_tree, 't0');
    assert.deepEqual(calls[2][2].tree.map((t) => t.path), ['a.overlay', 'b.conf']);
    assert.deepEqual(calls[3][2].parents, ['p1']);
    assert.equal(calls[4][2].sha, 'c1');
  } finally {
    globalThis.fetch = orig;
  }
});
