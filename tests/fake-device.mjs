// テスト用: ZMK Studio プロトコルで応答する偽の本体
import * as Z from '../vendor/zmk-studio-client.js';

const KP = { param1: [{ name: 'Key', hidUsage: { keyboardMax: 255, consumerMax: 1023 } }], param2: [] };
const LAYER = { param1: [{ name: 'Layer', layerId: {} }], param2: [] };
const NIL = { param1: [], param2: [] };

export const FAKE_BEHAVIORS = [
  { id: 1, displayName: 'Key Press', metadata: [KP] },
  { id: 2, displayName: 'Layer-Tap', metadata: [{ param1: LAYER.param1, param2: KP.param1 }] },
  { id: 3, displayName: 'Mod-Tap', metadata: [{ param1: KP.param1, param2: KP.param1 }] },
  { id: 4, displayName: 'Momentary Layer', metadata: [LAYER] },
  { id: 5, displayName: 'Transparent', metadata: [NIL] },
  { id: 6, displayName: 'None', metadata: [NIL] },
  { id: 7, displayName: 'Bluetooth', metadata: [{ param1: [{ name: 'Select', constant: 3 }], param2: [{ name: 'Profile', range: { min: 0, max: 4 } }] }] },
  { id: 8, displayName: 'Toggle Layer', metadata: [LAYER] },
  { id: 9, displayName: 'To Layer', metadata: [LAYER] },
  { id: 10, displayName: 'Mouse Key Press', metadata: [{ param1: [{ name: 'Button', range: { min: 0, max: 31 } }], param2: [] }] },
  { id: 11, displayName: 'mm2', metadata: [NIL] },
  { id: 12, displayName: 'hold_layer', metadata: [{ param1: LAYER.param1, param2: KP.param1 }] },
];

export function createFakeDevice({ layers, behaviors = FAKE_BEHAVIORS, locked = false, name = 'zonkey', available = 2 }) {
  const hostToDev = new TransformStream();
  const devToHost = new TransformStream();
  const abortController = new AbortController();
  const state = {
    layers: layers.map((l, i) => ({ id: i, name: l.name || '', bindings: l.bindings.map((b) => ({ ...b })) })),
    saved: null, locked, unsaved: false, available, log: [],
  };
  state.saved = JSON.parse(JSON.stringify(state.layers));
  const writer = devToHost.writable.getWriter();
  const send = async (msg) => { await writer.write(Z.Response.encode(msg).finish()); };
  const notify = (notification) => send({ notification });

  const handle = (req) => {
    const rr = { requestId: req.requestId };
    state.log.push(req);
    if (req.core) {
      if (req.core.getDeviceInfo) rr.core = { getDeviceInfo: { name, serialNumber: new Uint8Array([1, 2, 3]) } };
      else if (req.core.getLockState) rr.core = { getLockState: state.locked ? 0 : 1 };
      else if (req.core.resetSettings) { state.layers = JSON.parse(JSON.stringify(state.saved)); rr.core = { resetSettings: true }; }
      return rr;
    }
    if (state.locked) { rr.meta = { simpleError: 1 }; return rr; }
    if (req.behaviors) {
      if (req.behaviors.listAllBehaviors) rr.behaviors = { listAllBehaviors: { behaviors: behaviors.map((b) => b.id) } };
      else if (req.behaviors.getBehaviorDetails) {
        const b = behaviors.find((x) => x.id === req.behaviors.getBehaviorDetails.behaviorId);
        rr.behaviors = { getBehaviorDetails: b };
      }
      return rr;
    }
    const k = req.keymap || {};
    if (k.getKeymap) rr.keymap = { getKeymap: { layers: state.layers, availableLayers: state.available, maxLayerNameLength: 20 } };
    else if (k.setLayerBinding) {
      const { layerId, keyPosition, binding } = k.setLayerBinding;
      const layer = state.layers.find((l) => l.id === layerId);
      let code = 0;
      if (!layer || keyPosition >= layer.bindings.length) code = 1;
      else if (!behaviors.some((b) => b.id === binding.behaviorId)) code = 2;
      else { layer.bindings[keyPosition] = { behaviorId: binding.behaviorId, param1: binding.param1, param2: binding.param2 }; state.unsaved = true; }
      rr.keymap = { setLayerBinding: code };
    } else if (k.checkUnsavedChanges) rr.keymap = { checkUnsavedChanges: state.unsaved };
    else if (k.saveChanges) { state.saved = JSON.parse(JSON.stringify(state.layers)); state.unsaved = false; rr.keymap = { saveChanges: { ok: true } }; }
    else if (k.discardChanges) { state.layers = JSON.parse(JSON.stringify(state.saved)); state.unsaved = false; rr.keymap = { discardChanges: true }; }
    else if (k.setLayerProps) {
      const layer = state.layers.find((l) => l.id === k.setLayerProps.layerId);
      if (layer) layer.name = k.setLayerProps.name;
      rr.keymap = { setLayerProps: layer ? 0 : 2 };
    } else rr.meta = { noResponse: true };
    return rr;
  };

  (async () => {
    const reader = hostToDev.readable.pipeThrough(new TransformStream(Z.get_decoder())).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const req = Z.Request.decode(value);
      await send({ requestResponse: handle(req) });
    }
  })().catch(() => {});

  const transport = {
    label: 'fake',
    abortController,
    readable: devToHost.readable.pipeThrough(new TransformStream(Z.get_encoder())),
    writable: hostToDev.writable,
  };
  return { transport, state, notify, unlock: async () => { state.locked = false; await notify({ core: { lockStateChanged: 1 } }); } };
}
