const {contextBridge, ipcRenderer} = require('electron');

const methods = [
  'getManifest',
  'createSession',
  'cancelSession',
  'finalizeSession',
  'runBackend',
  'cancelBackend',
  'recordProgress',
  'recordRound',
  'recordLifecycle',
  'finish',
];

const api = {};
for (const name of methods) {
  api[name] = args => ipcRenderer.invoke(`stress-live:${name}`, args);
}

api.onStop = listener => {
  if (typeof listener !== 'function') return () => {};
  const handler = (_event, value) => listener(value);
  ipcRenderer.on('stress-live:stop', handler);
  return () => ipcRenderer.removeListener('stress-live:stop', handler);
};

contextBridge.exposeInMainWorld('stressLive', Object.freeze(api));
