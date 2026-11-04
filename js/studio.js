// ZMK Studio プロトコルで本体（Zonkey の右手側）と通信する

import * as Z from '../vendor/zmk-studio-client.js';

export const LOCKED = 0;
export const UNLOCKED = 1;

const BINDING_ERR = {
  1: 'キーの位置が正しくありません',
  2: 'この動作は本体で使えません',
  3: 'パラメーターが本体で受け付けられませんでした',
};

export function serialSupported() { return typeof navigator !== 'undefined' && 'serial' in navigator; }
export function bluetoothSupported() { return typeof navigator !== 'undefined' && 'bluetooth' in navigator; }

export class StudioDevice {
  /** transport: { label, abortController, readable, writable } */
  constructor(transport, { onNotify, onDisconnect } = {}) {
    this.transport = transport;
    this.onNotify = onNotify || (() => {});
    this.onDisconnect = onDisconnect || (() => {});
    this.conn = Z.create_rpc_connection(transport, { signal: transport.abortController.signal });
    this.closed = false;
    this.info = null;
    this.lockState = null;
    this.behaviors = [];
    this.keymap = null;
    this.unsaved = false;
    this.listen();
  }

  static async connect(kind, opts, makeTransport) {
    const transport = makeTransport ? await makeTransport() : kind === 'ble' ? await Z.connectGatt() : await Z.connectSerial();
    const dev = new StudioDevice(transport, opts);
    try {
      await dev.init();
    } catch (e) {
      dev.disconnect();
      throw e;
    }
    return dev;
  }

  async listen() {
    const reader = this.conn.notification_readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.core?.lockStateChanged != null) this.lockState = value.core.lockStateChanged;
        if (value.keymap?.unsavedChangesStatusChanged != null) this.unsaved = value.keymap.unsavedChangesStatusChanged;
        this.onNotify(value);
      }
    } catch { /* 切断 */ }
    finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
      if (!this.closed) { this.closed = true; this.onDisconnect(); }
    }
  }

  async rpc(req, timeoutMs = 8000) {
    if (this.closed) throw new Error('本体との接続が切れています');
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('本体から応答がありません（タイムアウト）')), timeoutMs); });
    try {
      const r = await Promise.race([Z.call_rpc(this.conn, req), timeout]);
      return r;
    } catch (e) {
      if (e instanceof Z.MetaError) {
        if (e.condition === 1) throw new Error('本体がロックされています。Zonkey の「Studio Unlock」キーを押してください。');
        throw new Error(`本体エラー（${e.condition}）`);
      }
      if (e instanceof Z.NoResponseError) throw new Error('本体がこの操作に対応していません');
      if (e instanceof Error && /タイムアウト/.test(e.message)) this.disconnect(); // 応答待ちが残るので接続し直す
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  async init() {
    this.info = (await this.rpc({ core: { getDeviceInfo: true } })).core.getDeviceInfo;
    this.lockState = (await this.rpc({ core: { getLockState: true } })).core.getLockState;
    if (this.lockState === LOCKED) return; // ロック解除の通知を待つ
    await this.loadAll();
  }

  async loadAll() {
    await this.loadBehaviors();
    await this.loadKeymap();
    try { this.unsaved = !!(await this.rpc({ keymap: { checkUnsavedChanges: true } })).keymap.checkUnsavedChanges; } catch { /* 古いファーム */ }
  }

  async loadBehaviors() {
    const ids = (await this.rpc({ behaviors: { listAllBehaviors: true } })).behaviors.listAllBehaviors.behaviors;
    const list = [];
    for (const id of ids) {
      const d = (await this.rpc({ behaviors: { getBehaviorDetails: { behaviorId: id } } })).behaviors.getBehaviorDetails;
      list.push({ id: d.id, displayName: d.displayName, metadata: d.metadata || [] });
    }
    this.behaviors = list;
    return list;
  }

  async loadKeymap() {
    this.keymap = (await this.rpc({ keymap: { getKeymap: true } })).keymap.getKeymap;
    return this.keymap;
  }

  layerIds() { return (this.keymap?.layers || []).map((l) => l.id); }
  layerIndexById() { return new Map((this.keymap?.layers || []).map((l, i) => [l.id, i])); }

  async setBinding(layerIndex, keyPosition, binding) {
    const layer = this.keymap.layers[layerIndex];
    if (!layer) throw new Error(`本体にレイヤー${layerIndex} がありません`);
    const r = (await this.rpc({ keymap: { setLayerBinding: { layerId: layer.id, keyPosition, binding } } })).keymap.setLayerBinding;
    if (r) throw new Error(BINDING_ERR[r] || `書き込み失敗（${r}）`);
    layer.bindings[keyPosition] = { ...binding };
    this.unsaved = true;
  }

  async setLayerName(layerIndex, name) {
    const layer = this.keymap.layers[layerIndex];
    const r = (await this.rpc({ keymap: { setLayerProps: { layerId: layer.id, name } } })).keymap.setLayerProps;
    if (r) throw new Error('レイヤー名を変更できませんでした');
    layer.name = name;
    this.unsaved = true;
  }

  async addLayer() {
    const r = (await this.rpc({ keymap: { addLayer: {} } })).keymap.addLayer;
    if (!r?.ok) throw new Error(r?.err === 2 ? '本体に空きレイヤーがありません（.keymap で予備のレイヤーを用意してビルドする必要があります）' : 'レイヤーを追加できませんでした');
    await this.loadKeymap();
    this.unsaved = true;
    return r.ok.index;
  }

  async removeLayer(layerIndex) {
    const r = (await this.rpc({ keymap: { removeLayer: { layerIndex } } })).keymap.removeLayer;
    if (!r?.ok) throw new Error('レイヤーを削除できませんでした');
    await this.loadKeymap();
    this.unsaved = true;
  }

  async save() {
    const r = (await this.rpc({ keymap: { saveChanges: true } }, 15000)).keymap.saveChanges;
    if (!r?.ok) throw new Error({ 2: '本体が保存に対応していません', 3: '本体の保存領域が足りません' }[r?.err] || '保存に失敗しました');
    this.unsaved = false;
  }

  async discard() {
    await this.rpc({ keymap: { discardChanges: true } });
    await this.loadKeymap();
    this.unsaved = false;
  }

  async resetSettings() {
    await this.rpc({ core: { resetSettings: true } }, 15000);
    await this.loadKeymap();
    this.unsaved = false;
  }

  disconnect() {
    if (this.closed) return;
    this.closed = true;
    try { this.transport.abortController.abort('切断'); } catch { /* ignore */ }
    this.onDisconnect();
  }
}
