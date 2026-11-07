// Zonkey の物理配列（公式 zmk-config-zonkey の config/zonkey.json より）
// 並び順は .keymap の bindings の並び順と同じ。

export const ZONKEY_LAYOUT = [
  { row: 1, col: 0, x: 0.25, y: 1 }, { row: 1, col: 1, x: 1.25, y: 1 }, { row: 1, col: 2, x: 2.25, y: 1 },
  { row: 1, col: 3, x: 3.25, y: 1 }, { row: 1, col: 4, x: 4.25, y: 1 },
  { row: 1, col: 8, x: 9.25, y: 1 }, { row: 1, col: 9, x: 10.25, y: 1 }, { row: 1, col: 10, x: 11.25, y: 1 },
  { row: 1, col: 11, x: 12.25, y: 1 }, { row: 1, col: 12, x: 13.25, y: 1 },

  { row: 2, col: 0, x: 0.75, y: 2 }, { row: 2, col: 1, x: 1.75, y: 2 }, { row: 2, col: 2, x: 2.75, y: 2 },
  { row: 2, col: 3, x: 3.75, y: 2 }, { row: 2, col: 4, x: 4.75, y: 2 }, { row: 2, col: 5, x: 6, y: 3.5 },
  { row: 2, col: 7, x: 9, y: 3 }, { row: 2, col: 8, x: 9.75, y: 2 }, { row: 2, col: 9, x: 10.75, y: 2 },
  { row: 2, col: 10, x: 11.75, y: 2 }, { row: 2, col: 11, x: 12.75, y: 2 }, { row: 2, col: 12, x: 13.75, y: 2 },

  { row: 3, col: 0, x: 0, y: 3 }, { row: 3, col: 1, x: 1, y: 3 }, { row: 3, col: 2, x: 2, y: 3 },
  { row: 3, col: 3, x: 3, y: 3 }, { row: 3, col: 4, x: 4, y: 3 }, { row: 3, col: 5, x: 5, y: 3 },
  { row: 3, col: 7, x: 8, y: 3.5 }, { row: 3, col: 8, x: 10, y: 3 }, { row: 3, col: 9, x: 11, y: 3 },
  { row: 3, col: 10, x: 12, y: 3 }, { row: 3, col: 11, x: 13, y: 3 }, { row: 3, col: 12, x: 14, y: 3 },

  { row: 4, col: 0, x: 0, y: 4 }, { row: 4, col: 1, x: 1, y: 4 }, { row: 4, col: 2, x: 2, y: 4 },
  { row: 4, col: 3, x: 3.219, y: 4.275 },
  { row: 4, col: 4, x: 4.342, y: 4.367, r: 9, rx: 4.842, ry: 4.117 },
  { row: 4, col: 5, x: 5.451, y: 4.659, r: 20, rx: 5.951, ry: 4.409 },
  { row: 4, col: 8, x: 7.759, y: 4.96, r: -20, rx: 7.559, ry: 4.41 },
  { row: 4, col: 9, x: 8.958, y: 4.566, r: -10, rx: 8.658, ry: 4.116 },
  { row: 4, col: 13, x: 14, y: 4 },
];

// .keymap に書き出すときの行ごとのキー数
export const ROW_SIZES = [[5, 5], [6, 6], [6, 6], [6, 3]];

// トラックボール（右手側）の表示位置。物理配列ファイルには無いので目安。
export const TRACKBALL = { cx: 11.9, cy: 4.75, r: 0.95 };

// ロータリーエンコーダー（sensors の順）。位置は目安。
export const ENCODERS = [
  { name: '左手のエンコーダー', cx: 5.78, cy: 1.48, r: 0.48 },
];

// シミュレーターで PC のキーボードから押すときの割り当て（event.code）
// 位置が近いキーを選んでいる。
export const PC_KEYMAP = [
  ['KeyQ'], ['KeyW'], ['KeyE'], ['KeyR'], ['KeyT'], ['KeyY'], ['KeyU'], ['KeyI'], ['KeyO'], ['KeyP'],
  ['KeyA'], ['KeyS'], ['KeyD'], ['KeyF'], ['KeyG'], ['Digit5'], ['Digit6'], ['KeyH'], ['KeyJ'], ['KeyK'], ['KeyL'], ['Semicolon'],
  ['ShiftLeft'], ['KeyZ'], ['KeyX'], ['KeyC'], ['KeyV'], ['KeyB'], ['Digit7'], ['KeyN'], ['KeyM'], ['Comma'], ['Period'], ['Slash'],
  ['ControlLeft', 'Digit1'], ['Digit2'], ['Digit3'], ['NonConvert', 'Digit4'], ['Space'], ['Convert', 'AltLeft'],
  ['Backspace', 'AltRight'], ['Enter'], ['Delete', 'Quote', 'IntlRo'],
];

export function pcKeyLabel(code) {
  if (!code) return '';
  return code
    .replace(/^Key/, '').replace(/^Digit/, '')
    .replace('ShiftLeft', 'Shift').replace('ControlLeft', 'Ctrl')
    .replace('NonConvert', '無変換').replace('Convert', '変換')
    .replace('Space', 'Space').replace('Semicolon', ';').replace('Comma', ',')
    .replace('Period', '.').replace('Slash', '/').replace('Backspace', 'BS')
    .replace('AltLeft', 'Alt').replace('AltRight', 'AltR').replace('Quote', "'");
}

export function positionName(i) {
  const k = ZONKEY_LAYOUT[i];
  if (!k) return `キー${i}`;
  const side = k.x < 7 ? '左手' : '右手';
  const rowName = ['', '上段', '中段', '下段', '親指段'][k.row];
  return `${side}・${rowName}（#${i}）`;
}

export function layoutBounds(layout = ZONKEY_LAYOUT) {
  let maxX = 0, maxY = 0, minY = Infinity;
  for (const k of layout) {
    maxX = Math.max(maxX, k.x + 1);
    maxY = Math.max(maxY, k.y + 1);
    minY = Math.min(minY, k.y);
  }
  return { w: maxX, h: Math.max(maxY, TRACKBALL.cy + TRACKBALL.r) + 0.4, minY };
}
