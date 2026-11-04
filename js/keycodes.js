// ZMK のキーコード定義と、PC 側の配列（JIS / US）での見え方。
// usage は HID Keyboard/Keypad ページの値。consumer は 0x10000 を足して区別する。

const C = 0x10000; // consumer page offset

// [名前の一覧, usage, カテゴリ, 日本語説明, US(通常), US(Shift), JIS(通常), JIS(Shift), DOM の event.code]
// 文字が null のものは、ラベルとして日本語説明の短縮形を使う。
const RAW = [
  // 修飾キー
  [['LEFT_CONTROL', 'LCTRL', 'LCTL'], 0xe0, 'mod', '左Ctrl', 'Ctrl', null, 'Ctrl', null, 'ControlLeft'],
  [['LEFT_SHIFT', 'LSHIFT', 'LSHFT', 'LSFT'], 0xe1, 'mod', '左Shift', 'Shift', null, 'Shift', null, 'ShiftLeft'],
  [['LEFT_ALT', 'LALT'], 0xe2, 'mod', '左Alt', 'Alt', null, 'Alt', null, 'AltLeft'],
  [['LEFT_GUI', 'LGUI', 'LEFT_WIN', 'LWIN', 'LEFT_COMMAND', 'LCMD', 'LEFT_META', 'LMETA'], 0xe3, 'mod', '左Win / Cmd', 'Win', null, 'Win', null, 'MetaLeft'],
  [['RIGHT_CONTROL', 'RCTRL', 'RCTL'], 0xe4, 'mod', '右Ctrl', 'RCtrl', null, 'RCtrl', null, 'ControlRight'],
  [['RIGHT_SHIFT', 'RSHIFT', 'RSHFT', 'RSFT'], 0xe5, 'mod', '右Shift', 'RShift', null, 'RShift', null, 'ShiftRight'],
  [['RIGHT_ALT', 'RALT'], 0xe6, 'mod', '右Alt', 'RAlt', null, 'RAlt', null, 'AltRight'],
  [['RIGHT_GUI', 'RGUI', 'RIGHT_WIN', 'RWIN', 'RIGHT_COMMAND', 'RCMD', 'RIGHT_META', 'RMETA'], 0xe7, 'mod', '右Win / Cmd', 'RWin', null, 'RWin', null, 'MetaRight'],

  // 数字
  [['N1', 'NUMBER_1'], 30, 'num', '1', '1', '!', '1', '!', 'Digit1'],
  [['N2', 'NUMBER_2'], 31, 'num', '2', '2', '@', '2', '"', 'Digit2'],
  [['N3', 'NUMBER_3'], 32, 'num', '3', '3', '#', '3', '#', 'Digit3'],
  [['N4', 'NUMBER_4'], 33, 'num', '4', '4', '$', '4', '$', 'Digit4'],
  [['N5', 'NUMBER_5'], 34, 'num', '5', '5', '%', '5', '%', 'Digit5'],
  [['N6', 'NUMBER_6'], 35, 'num', '6', '6', '^', '6', '&', 'Digit6'],
  [['N7', 'NUMBER_7'], 36, 'num', '7', '7', '&', '7', "'", 'Digit7'],
  [['N8', 'NUMBER_8'], 37, 'num', '8', '8', '*', '8', '(', 'Digit8'],
  [['N9', 'NUMBER_9'], 38, 'num', '9', '9', '(', '9', ')', 'Digit9'],
  [['N0', 'NUMBER_0'], 39, 'num', '0', '0', ')', '0', '', 'Digit0'],

  // 編集・制御
  [['RETURN', 'ENTER', 'RET'], 40, 'edit', 'Enter', 'Enter', null, 'Enter', null, 'Enter'],
  [['ESCAPE', 'ESC'], 41, 'edit', 'Esc', 'Esc', null, 'Esc', null, 'Escape'],
  [['BACKSPACE', 'BSPC', 'BKSP'], 42, 'edit', 'BackSpace（後退）', 'BS', null, 'BS', null, 'Backspace'],
  [['TAB'], 43, 'edit', 'Tab', 'Tab', null, 'Tab', null, 'Tab'],
  [['SPACE', 'SPC'], 44, 'edit', 'スペース', 'Space', null, 'Space', null, 'Space'],

  // 記号（US の名前。JIS の PC では刻印と違う文字が出る）
  [['MINUS'], 45, 'sym', '- キー', '-', '_', '-', '=', 'Minus'],
  [['EQUAL'], 46, 'sym', '= キー（JIS: ^）', '=', '+', '^', '~', 'Equal'],
  [['LEFT_BRACKET', 'LBKT'], 47, 'sym', '[ キー（JIS: @）', '[', '{', '@', '`', 'BracketLeft'],
  [['RIGHT_BRACKET', 'RBKT'], 48, 'sym', '] キー（JIS: [）', ']', '}', '[', '{', 'BracketRight'],
  [['BACKSLASH', 'BSLH'], 49, 'sym', '\\ キー（JIS: ]）', '\\', '|', ']', '}', 'Backslash'],
  [['NON_US_HASH', 'NUHS'], 50, 'sym', '非US # キー（JIS: ]）', '#', '~', ']', '}', 'Backslash'],
  [['SEMICOLON', 'SEMI'], 51, 'sym', '; キー', ';', ':', ';', '+', 'Semicolon'],
  [['SINGLE_QUOTE', 'SQT', 'APOSTROPHE', 'APOS', 'QUOT'], 52, 'sym', "' キー（JIS: :）", "'", '"', ':', '*', 'Quote'],
  [['GRAVE'], 53, 'sym', '` キー（JIS: 半角/全角）', '`', '~', '半/全', '半/全', 'Backquote'],
  [['COMMA'], 54, 'sym', ', キー', ',', '<', ',', '<', 'Comma'],
  [['PERIOD', 'DOT'], 55, 'sym', '. キー', '.', '>', '.', '>', 'Period'],
  [['SLASH', 'FSLH'], 56, 'sym', '/ キー', '/', '?', '/', '?', 'Slash'],
  [['NON_US_BACKSLASH', 'NUBS'], 100, 'sym', '非US \\ キー', '\\', '|', '\\', '|', 'IntlBackslash'],

  // 日本語入力
  [['INTERNATIONAL_1', 'INT1', 'INT_RO'], 0x87, 'ja', 'ろ キー（\\ _）', '\\', '_', '\\', '_', 'IntlRo'],
  [['INTERNATIONAL_2', 'INT2', 'INT_KATAKANAHIRAGANA', 'INT_KANA'], 0x88, 'ja', 'カタカナ/ひらがな', 'かな', null, 'カタひら', null, 'KanaMode'],
  [['INTERNATIONAL_3', 'INT3', 'INT_YEN'], 0x89, 'ja', '¥ キー（¥ |）', '¥', '|', '¥', '|', 'IntlYen'],
  [['INTERNATIONAL_4', 'INT4', 'INT_HENKAN'], 0x8a, 'ja', '変換', '変換', null, '変換', null, 'Convert'],
  [['INTERNATIONAL_5', 'INT5', 'INT_MUHENKAN'], 0x8b, 'ja', '無変換', '無変換', null, '無変換', null, 'NonConvert'],
  [['LANGUAGE_1', 'LANG1', 'LANG_HANGEUL'], 0x90, 'ja', 'かな（Mac / IME オン）', 'かな', null, 'かな', null, 'Lang1'],
  [['LANGUAGE_2', 'LANG2', 'LANG_HANJA'], 0x91, 'ja', '英数（Mac / IME オフ）', '英数', null, '英数', null, 'Lang2'],

  // 移動
  [['RIGHT_ARROW', 'RIGHT'], 79, 'nav', '→', '→', null, '→', null, 'ArrowRight'],
  [['LEFT_ARROW', 'LEFT'], 80, 'nav', '←', '←', null, '←', null, 'ArrowLeft'],
  [['DOWN_ARROW', 'DOWN'], 81, 'nav', '↓', '↓', null, '↓', null, 'ArrowDown'],
  [['UP_ARROW', 'UP'], 82, 'nav', '↑', '↑', null, '↑', null, 'ArrowUp'],
  [['HOME'], 74, 'nav', 'Home', 'Home', null, 'Home', null, 'Home'],
  [['END'], 77, 'nav', 'End', 'End', null, 'End', null, 'End'],
  [['PAGE_UP', 'PG_UP'], 75, 'nav', 'PageUp', 'PgUp', null, 'PgUp', null, 'PageUp'],
  [['PAGE_DOWN', 'PG_DN'], 78, 'nav', 'PageDown', 'PgDn', null, 'PgDn', null, 'PageDown'],
  [['INSERT', 'INS'], 73, 'nav', 'Insert', 'Ins', null, 'Ins', null, 'Insert'],
  [['DELETE', 'DEL'], 76, 'nav', 'Delete（削除）', 'Del', null, 'Del', null, 'Delete'],
  [['CAPSLOCK', 'CAPS', 'CLCK'], 57, 'nav', 'CapsLock（JIS: 英数）', 'Caps', null, 'Caps', null, 'CapsLock'],
  [['PRINTSCREEN', 'PSCRN'], 70, 'nav', 'PrintScreen', 'PrtSc', null, 'PrtSc', null, 'PrintScreen'],
  [['SCROLLLOCK', 'SLCK'], 71, 'nav', 'ScrollLock', 'ScrLk', null, 'ScrLk', null, 'ScrollLock'],
  [['PAUSE_BREAK'], 72, 'nav', 'Pause', 'Pause', null, 'Pause', null, 'Pause'],
  [['K_APPLICATION', 'K_APP', 'K_CONTEXT_MENU', 'K_CMENU'], 101, 'nav', 'アプリケーション（右クリックメニュー）', 'Menu', null, 'Menu', null, 'ContextMenu'],

  // テンキー
  [['KP_NUMLOCK', 'KP_NUM', 'KP_NLCK'], 83, 'kp', 'NumLock', 'NumLk', null, 'NumLk', null, 'NumLock'],
  [['KP_DIVIDE', 'KP_SLASH'], 84, 'kp', 'テンキー /', '/', null, '/', null, 'NumpadDivide'],
  [['KP_MULTIPLY', 'KP_ASTERISK'], 85, 'kp', 'テンキー *', '*', null, '*', null, 'NumpadMultiply'],
  [['KP_MINUS', 'KP_SUBTRACT'], 86, 'kp', 'テンキー -', '-', null, '-', null, 'NumpadSubtract'],
  [['KP_PLUS'], 87, 'kp', 'テンキー +', '+', null, '+', null, 'NumpadAdd'],
  [['KP_ENTER'], 88, 'kp', 'テンキー Enter', 'Enter', null, 'Enter', null, 'NumpadEnter'],
  [['KP_NUMBER_1', 'KP_N1'], 89, 'kp', 'テンキー 1', '1', null, '1', null, 'Numpad1'],
  [['KP_NUMBER_2', 'KP_N2'], 90, 'kp', 'テンキー 2', '2', null, '2', null, 'Numpad2'],
  [['KP_NUMBER_3', 'KP_N3'], 91, 'kp', 'テンキー 3', '3', null, '3', null, 'Numpad3'],
  [['KP_NUMBER_4', 'KP_N4'], 92, 'kp', 'テンキー 4', '4', null, '4', null, 'Numpad4'],
  [['KP_NUMBER_5', 'KP_N5'], 93, 'kp', 'テンキー 5', '5', null, '5', null, 'Numpad5'],
  [['KP_NUMBER_6', 'KP_N6'], 94, 'kp', 'テンキー 6', '6', null, '6', null, 'Numpad6'],
  [['KP_NUMBER_7', 'KP_N7'], 95, 'kp', 'テンキー 7', '7', null, '7', null, 'Numpad7'],
  [['KP_NUMBER_8', 'KP_N8'], 96, 'kp', 'テンキー 8', '8', null, '8', null, 'Numpad8'],
  [['KP_NUMBER_9', 'KP_N9'], 97, 'kp', 'テンキー 9', '9', null, '9', null, 'Numpad9'],
  [['KP_NUMBER_0', 'KP_N0'], 98, 'kp', 'テンキー 0', '0', null, '0', null, 'Numpad0'],
  [['KP_DOT'], 99, 'kp', 'テンキー .', '.', null, '.', null, 'NumpadDecimal'],
  [['KP_EQUAL'], 103, 'kp', 'テンキー =', '=', null, '=', null, 'NumpadEqual'],
  [['KP_COMMA'], 133, 'kp', 'テンキー ,', ',', null, ',', null, 'NumpadComma'],

  // メディア（consumer）
  [['C_VOLUME_UP', 'C_VOL_UP'], C + 0xe9, 'media', '音量アップ', 'Vol+', null, 'Vol+', null, 'AudioVolumeUp'],
  [['C_VOLUME_DOWN', 'C_VOL_DN'], C + 0xea, 'media', '音量ダウン', 'Vol-', null, 'Vol-', null, 'AudioVolumeDown'],
  [['C_MUTE'], C + 0xe2, 'media', 'ミュート', 'Mute', null, 'Mute', null, 'AudioVolumeMute'],
  [['C_PLAY_PAUSE', 'C_PP'], C + 0xcd, 'media', '再生 / 一時停止', '⏯', null, '⏯', null, 'MediaPlayPause'],
  [['C_NEXT'], C + 0xb5, 'media', '次の曲', '⏭', null, '⏭', null, 'MediaTrackNext'],
  [['C_PREVIOUS', 'C_PREV'], C + 0xb6, 'media', '前の曲', '⏮', null, '⏮', null, 'MediaTrackPrevious'],
  [['C_STOP'], C + 0xb7, 'media', '停止', '⏹', null, '⏹', null, 'MediaStop'],
  [['C_BRIGHTNESS_INC', 'C_BRI_UP', 'C_BRI_INC'], C + 0x6f, 'media', '画面の明るさ +', '☀+', null, '☀+', null, null],
  [['C_BRIGHTNESS_DEC', 'C_BRI_DN', 'C_BRI_DEC'], C + 0x70, 'media', '画面の明るさ -', '☀-', null, '☀-', null, null],
];

// アルファベット
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(65 + i);
  RAW.push([[ch], 4 + i, 'alpha', ch, ch.toLowerCase(), ch, ch.toLowerCase(), ch, 'Key' + ch]);
}
// F キー
for (let i = 1; i <= 24; i++) {
  const usage = i <= 12 ? 57 + i : 103 + (i - 12);
  RAW.push([['F' + i], usage, 'fn', 'F' + i, 'F' + i, null, 'F' + i, null, 'F' + i]);
}

// Shift 付きの別名（ZMK の keys.h と同じ定義）
const SHIFTED = {
  EXCLAMATION: 'N1', EXCL: 'N1',
  AT_SIGN: 'N2', AT: 'N2',
  HASH: 'N3', POUND: 'N3',
  DOLLAR: 'N4', DLLR: 'N4',
  PERCENT: 'N5', PRCNT: 'N5',
  CARET: 'N6',
  AMPERSAND: 'N7', AMPS: 'N7',
  ASTERISK: 'N8', ASTRK: 'N8', STAR: 'N8',
  LEFT_PARENTHESIS: 'N9', LPAR: 'N9',
  RIGHT_PARENTHESIS: 'N0', RPAR: 'N0',
  UNDERSCORE: 'MINUS', UNDER: 'MINUS',
  PLUS: 'EQUAL',
  LEFT_BRACE: 'LBKT', LBRC: 'LBKT',
  RIGHT_BRACE: 'RBKT', RBRC: 'RBKT',
  PIPE: 'BSLH',
  PIPE2: 'NUHS',
  TILDE: 'GRAVE',
  TILDE2: 'NUHS',
  COLON: 'SEMI',
  DOUBLE_QUOTES: 'SQT', DQT: 'SQT',
  LESS_THAN: 'COMMA', LT: 'COMMA',
  GREATER_THAN: 'DOT', GT: 'DOT',
  QUESTION: 'SLASH', QMARK: 'SLASH',
};

export const MOD_BITS = { LCTRL: 1, LSHIFT: 2, LALT: 4, LGUI: 8, RCTRL: 16, RSHIFT: 32, RALT: 64, RGUI: 128 };
export const MOD_FUNCS = { LC: 1, LS: 2, LA: 4, LG: 8, RC: 16, RS: 32, RA: 64, RG: 128 };
export const MOD_USAGE_BIT = { 0xe0: 1, 0xe1: 2, 0xe2: 4, 0xe3: 8, 0xe4: 16, 0xe5: 32, 0xe6: 64, 0xe7: 128 };
export const SHIFT_MASK = 2 | 32;
export const CTRL_MASK = 1 | 16;
export const ALT_MASK = 4 | 64;
export const GUI_MASK = 8 | 128;

export const KEYS = []; // 正規化したキー一覧
const byName = new Map();
const byUsage = new Map();
const byCode = new Map();

for (const [names, usage, cat, ja, us, usS, jis, jisS, code] of RAW) {
  const k = { name: names[0], names, usage, cat, ja, us, usS, jis, jisS, code };
  KEYS.push(k);
  for (const n of names) byName.set(n, k);
  if (!byUsage.has(usage)) byUsage.set(usage, k);
  if (code && !byCode.has(code)) byCode.set(code, k);
}
// ブラウザの event.code の別名
byCode.set('OSLeft', byName.get('LGUI'));
byCode.set('OSRight', byName.get('RGUI'));
byCode.set('Lang1', byName.get('LANG1'));
byCode.set('Lang2', byName.get('LANG2'));
byCode.set('IntlYen', byName.get('INT3'));
byCode.set('Backslash', byName.get('BSLH'));

export const MOD_KEY_NAMES = ['LCTRL', 'LSHIFT', 'LALT', 'LGUI', 'RCTRL', 'RSHIFT', 'RALT', 'RGUI'];

export function keyByName(name) { return byName.get(name) || null; }
export function keyByUsage(usage) { return byUsage.get(usage) || null; }
export function keyByCode(code) { return byCode.get(code) || null; }
export function isShiftedAlias(name) { return Object.prototype.hasOwnProperty.call(SHIFTED, name); }

/**
 * キー式（例: "LS(LG(S))", "AT", "0x89"）を {mods, usage, key} に変換する。
 * defines で展開済みの文字列を渡すこと。解釈できなければ null。
 */
export function parseKeyExpr(expr) {
  let s = String(expr).replace(/\s+/g, '');
  let mods = 0;
  // 外側から修飾関数をはがす
  for (;;) {
    const m = /^([LR][CSAG])\((.*)\)$/.exec(s);
    if (!m) break;
    mods |= MOD_FUNCS[m[1]];
    s = m[2];
  }
  // 修飾マスク付き数値 (ZMK では上位バイトが修飾) は数値として扱う
  if (/^(0x[0-9a-f]+|\d+)$/i.test(s)) {
    let v = parseInt(s);
    const hi = (v >>> 24) & 0xff;
    if (hi) { mods |= hi; v &= 0xffffff; }
    // ZMK のエンコーディング: (page << 16) | id。キーボードページは 0x07
    const page = v >>> 16;
    const id = v & 0xffff;
    let usage = id;
    if (page === 0x0c) usage = C + id;
    return { mods, usage, key: keyByUsage(usage), raw: s };
  }
  if (isShiftedAlias(s)) {
    mods |= MOD_FUNCS.LS;
    s = SHIFTED[s];
  }
  const key = keyByName(s);
  if (!key) return null;
  return { mods, usage: key.usage, key, raw: s };
}

export function modsToNames(mods, ja = false) {
  const out = [];
  if (mods & CTRL_MASK) out.push('Ctrl');
  if (mods & SHIFT_MASK) out.push('Shift');
  if (mods & ALT_MASK) out.push('Alt');
  if (mods & GUI_MASK) out.push(ja ? 'Win' : 'Win');
  return out;
}

/** PC 側で実際に出る文字（なければ null） */
export function charFor(key, shift, host) {
  if (!key) return null;
  if (host === 'jis') return shift ? (key.jisS ?? null) : key.jis;
  return shift ? (key.usS ?? null) : key.us;
}

/** 文字を入力するキーかどうか */
export function isPrintable(key) {
  if (!key) return false;
  return ['alpha', 'num', 'sym'].includes(key.cat) || key.usage === 0x87 || key.usage === 0x89;
}

/** 実際に文字が入力されるか（JIS の半角/全角キーは文字ではない） */
export function producesText(key, host) {
  if (!isPrintable(key)) return false;
  if (host === 'jis' && key.usage === 53) return false;
  return true;
}

/**
 * キーキャップに表示する短いラベル。
 * host = 'jis' | 'us'
 */
export function keyLabel(expr, host = 'jis') {
  const p = typeof expr === 'string' ? parseKeyExpr(expr) : expr;
  if (!p) return { main: String(expr), sub: '' };
  const key = p.key;
  const shift = !!(p.mods & SHIFT_MASK);
  const otherMods = p.mods & ~SHIFT_MASK;
  let main;
  if (!key) {
    main = '0x' + p.usage.toString(16);
  } else if (isPrintable(key)) {
    const ch = charFor(key, shift, host);
    main = ch === '' ? '(なし)' : ch;
    if (key.cat === 'alpha') main = key.us.toUpperCase();
    if (key.cat === 'alpha' && shift) main = 'Shift+' + key.us.toUpperCase();
  } else {
    main = host === 'jis' ? key.jis : key.us;
    if (shift) main = 'Shift+' + main;
  }
  if (otherMods) {
    const names = modsToNames(otherMods);
    if (key && key.cat === 'alpha') main = names.join('+') + '+' + (shift ? 'Shift+' : '') + key.us.toUpperCase();
    else main = names.join('+') + '+' + main;
  }
  return { main, sub: '' };
}

/** キーを日本語で説明 */
export function keyDescribe(expr, host = 'jis') {
  const p = typeof expr === 'string' ? parseKeyExpr(expr) : expr;
  if (!p) return `不明なキー（${expr}）`;
  const label = keyLabel(p, host).main;
  const key = p.key;
  if (!key) return `キーコード ${label}`;
  const shift = !!(p.mods & SHIFT_MASK);
  const other = p.mods & ~SHIFT_MASK;
  if (other) return `ショートカット ${label}`;
  if (producesText(key, host)) {
    const ch = key.cat === 'alpha' ? (shift ? key.us.toUpperCase() : key.us) : charFor(key, shift, host);
    const alt = host === 'jis' ? charFor(key, shift, 'us') : charFor(key, shift, 'jis');
    let s = ch ? `「${ch}」を入力` : '何も入力されない（JIS で Shift+0）';
    if (key.cat !== 'alpha' && alt && alt !== ch) s += `（${host === 'jis' ? 'US' : 'JIS'} 配列の PC では「${alt}」）`;
    return s;
  }
  return shift ? `Shift+${key.ja}` : key.ja;
}

/**
 * JIS 配列の PC で「この文字を出したい」ときの ZMK 表記の一覧。
 * 例: '@' → 'LBKT', '"' → 'LS(N2)'
 */
export function charTable(host = 'jis') {
  const list = [];
  const seen = new Set();
  for (const k of KEYS) {
    if (!['num', 'sym', 'ja'].includes(k.cat)) continue;
    if (k.name === 'NUHS' || k.name === 'NUBS') continue;
    if (!producesText(k, host)) continue;
    const base = charFor(k, false, host);
    const sh = charFor(k, true, host);
    if (base && !seen.has(base) && !/^[0-9]$/.test(base)) { seen.add(base); list.push({ ch: base, expr: k.name }); }
    if (sh && !seen.has(sh)) { seen.add(sh); list.push({ ch: sh, expr: `LS(${k.name})` }); }
  }
  return list;
}

export const CATEGORIES = [
  ['alpha', 'アルファベット'],
  ['num', '数字'],
  ['sym', '記号'],
  ['ja', '日本語入力'],
  ['edit', '編集'],
  ['nav', '移動・その他'],
  ['mod', '修飾キー'],
  ['fn', 'ファンクション'],
  ['kp', 'テンキー'],
  ['media', 'メディア'],
];

/** event.code → ZMK のキー名（なければ null） */
export function zmkNameFromCode(code) {
  const k = keyByCode(code);
  return k ? k.name : null;
}
