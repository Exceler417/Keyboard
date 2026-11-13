// SVG アイコン（線の太さをそろえた自作アイコン）と、画面中の絵文字の置き換え

const P = {
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  sim: '<circle cx="12" cy="12" r="9"/><path d="m10 8.5 5 3.5-5 3.5Z"/>',
  plug: '<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0Z"/><path d="M12 17v5"/>',
  ball: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
  save: '<path d="M12 15V4"/><path d="m7 8 5-5 5 5"/><path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  up: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  down: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3.5L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14.9 3.5L20 15"/><path d="M20 20v-5h-5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  knob: '<circle cx="12" cy="12" r="8"/><path d="M12 4v5"/><path d="M4.5 15.5 3 17M19.5 15.5 21 17"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  ble: '<path d="m7 7 10 10-5 5V2l5 5L7 17"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  xcircle: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
  auto: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.2"/><circle cx="17.5" cy="10.5" r="1.2"/><circle cx="8.5" cy="7.5" r="1.2"/><circle cx="6.5" cy="12.5" r="1.2"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.3A5.7 5.7 0 0 0 22 9.7C22 5.4 17.5 2 12 2Z"/>',
};

const EMOJI = {
  '✏️': 'edit', '🧪': 'sim', '🔌': 'plug', '🖲': 'ball', '🔗': 'link', '📄': 'file', '💾': 'save', '📂': 'folder',
  '⚙': 'gear', '🎛': 'knob', '⬆': 'up', '⬇': 'down', '🔄': 'refresh', '⚠️': 'alert', '⚠': 'alert', '↩': 'undo',
  '🔒': 'lock', '📶': 'ble', '📋': 'copy', '✅': 'check', '🎉': 'check', '💡': 'info', '⛔': 'xcircle', '🖱': 'mouse',
};
const EMOJI_RE = new RegExp(`(${Object.keys(EMOJI).sort((a, b) => b.length - a.length).map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\ufe0f?\\s?`, 'g');

export function iconSvg(name, cls = 'ic') {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || ''}</svg>`;
}

export function icon(name, cls = 'ic') {
  const t = document.createElement('template');
  t.innerHTML = iconSvg(name, cls);
  return t.content.firstChild;
}

/** 絵文字を含むテキストを、アイコンに置き換える */
function decorateText(node) {
  const text = node.data;
  EMOJI_RE.lastIndex = 0;
  if (!EMOJI_RE.test(text)) return;
  const parent = node.parentNode;
  if (!parent || parent.closest?.('textarea, .no-icons, svg')) return;
  EMOJI_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(EMOJI_RE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    frag.append(icon(EMOJI[m[1]] || EMOJI[m[1].replace('️', '')]));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  parent.replaceChild(frag, node);
}

export function decorate(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) { decorateText(root); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(decorateText);
}

/** 画面が更新されるたびに絵文字をアイコンへ置き換える */
export function startIconObserver() {
  decorate(document.body);
  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') decorateText(m.target);
      m.addedNodes.forEach(decorate);
    }
  });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
}
