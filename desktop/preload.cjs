const {contextBridge,ipcRenderer}=require('electron');
const api={};
for(const name of ['bootstrap','saveSettings','saveConnection','testConnection','cancelTest','createSession','cancelSession','finalizeSession','runBackend','cancelBackend','saveHistory','loadHistory','renameHistory','deleteHistory','exportQr','saveQrPng','readyToClose']) {
  api[name]=args=>ipcRenderer.invoke(`live-voice:${name}`,args);
}
api.onClosing=listener=>{
  if(typeof listener!=='function')return()=>{};
  const handler=()=>listener();
  ipcRenderer.on('live-voice:closing',handler);
  return()=>ipcRenderer.removeListener('live-voice:closing',handler);
};
contextBridge.exposeInMainWorld('liveVoice',Object.freeze(api));
