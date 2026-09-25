import {app,BrowserWindow,ipcMain,protocol,net,session,safeStorage,dialog} from 'electron';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {writeFile,mkdir} from 'node:fs/promises';
import {createServices} from './services.mjs';
import {ErrorCode} from '../native/src/protocol.ts';

const APP_URL='live-voice://app/index.html';
protocol.registerSchemesAsPrivileged([{scheme:'live-voice',privileges:{standard:true,secure:true,supportFetchAPI:true}}]);
app.setName('Live Voice');
// Keep desktop user data separate from mobile, the QR web page, and Codex.
app.setPath('userData',path.join(app.getPath('appData'),'LiveVoiceDesktop'));
app.commandLine.appendSwitch('disable-logging');
let window;
let services;
let closing=false;
let finishing=false;
let closeTimer;
const safeCodes=new Set([...Object.values(ErrorCode),
  'invalid_config','invalid_endpoint','invalid_model','invalid_key','invalid_passphrase','payload_too_large','unsupported_version','invalid_payload','decrypt_failed',
  'auth_failed','access_denied','model_unavailable','endpoint_not_found','request_rejected','rate_limited','service_unavailable','network_error','timeout','cancelled','invalid_response','response_incomplete','close_unconfirmed','redirect_refused',
  'storage_failed','encryption_unavailable','key_required','not_configured','backend_not_configured','invalid_request','invalid_record','session_not_found','session_exists','busy','save_failed','operation_failed',
  'test_in_progress','test_busy','test_cancelled','backend_in_progress','credential_missing','qr_failed',
  'backend_token_limit','backend_content_filter',
  'history_not_found','invalid_title',
]);
const serviceNames=['bootstrap','saveSettings','saveConnection','testConnection','cancelTest','createSession','cancelSession','finalizeSession','runBackend','cancelBackend','saveHistory','loadHistory','renameHistory','deleteHistory','exportQr'];
function validSender(event) {
  return Boolean(window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame&&event.senderFrame.url===APP_URL);
}
function resultError(error) {
  const code=error?.code||error?.message;
  return {ok:false,code:safeCodes.has(code)?code:'operation_failed'};
}
async function saveQrPng({dataUrl}={}) {
  if(typeof dataUrl!=='string'||dataUrl.length>3_000_000||!/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(dataUrl)) throw Error('invalid_request');
  const bytes=Buffer.from(dataUrl.slice('data:image/png;base64,'.length),'base64');
  if(bytes.length>2_000_000||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('invalid_request');
  const result=await dialog.showSaveDialog(window,{title:'Live Voice — QR',defaultPath:'live-voice-encrypted-config.png',filters:[{name:'PNG',extensions:['png']}],properties:['showOverwriteConfirmation']});
  if(result.canceled||!result.filePath)return {saved:false};
  try {await writeFile(result.filePath,bytes);} catch {throw Error('save_failed');}
  return {saved:true};
}
async function finishClose() {
  if(finishing)return;
  finishing=true;
  clearTimeout(closeTimer);
  await services?.dispose().catch(()=>undefined);
  if(window&&!window.isDestroyed())window.destroy();
  app.quit();
}
async function initialize() {
  console.log('desktop_initializing');
  const rendererRoot=path.join(app.getAppPath(),'dist','renderer');
  const assets=new Set(['index.html','app.js','styles.css','logo.png']);
  await protocol.handle('live-voice',async request=>{
    const url=new URL(request.url);
    const name=url.pathname.slice(1);
    if(url.host!=='app'||url.search||url.hash||!assets.has(name)||request.method!=='GET')return new Response('',{status:404});
    const response=await net.fetch(pathToFileURL(path.join(rendererRoot,name)).toString());
    const headers=new Headers(response.headers);
    headers.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'");
    headers.set('Cache-Control','no-store');
    headers.set('X-Content-Type-Options','nosniff');
    return new Response(response.body,{status:response.status,headers});
  });
  await mkdir(app.getPath('userData'),{recursive:true});
  services=await createServices({dataDir:app.getPath('userData'),safeStorage});
  console.log('desktop_services_ready');
  window=new BrowserWindow({width:1180,height:860,minWidth:900,minHeight:640,title:'Live Voice',backgroundColor:'#faf8f3',icon:path.join(rendererRoot,'logo.png'),show:false,autoHideMenuBar:true,webPreferences:{preload:path.join(app.getAppPath(),'dist','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,spellcheck:false}});
  window.removeMenu();
  window.webContents.on('did-fail-load',(_event,code)=>console.error('renderer_load_failed',code));
  window.webContents.on('did-finish-load',()=>console.log('renderer_loaded'));
  session.defaultSession.setPermissionCheckHandler((contents,permission,origin,details)=>
    contents===window.webContents&&(origin==='live-voice://app'||origin==='live-voice://app/')&&
    (permission==='speaker-selection'||(permission==='media'&&details?.mediaType==='audio')));
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback,details)=>{
    const audioOnly=Array.isArray(details.mediaTypes)&&details.mediaTypes.length>0&&details.mediaTypes.every(type=>type==='audio');
    callback(contents===window.webContents&&contents.getURL()===APP_URL&&(permission==='speaker-selection'||(permission==='media'&&audioOnly)));
  });
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(url!==APP_URL)event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  for(const name of serviceNames)ipcMain.handle(`live-voice:${name}`,async(event,args)=>{
    if(!validSender(event))return {ok:false,code:'access_denied'};
    try {return {ok:true,value:await services[name](args)};} catch(error){return resultError(error);}
  });
  ipcMain.handle('live-voice:saveQrPng',async(event,args)=>{
    if(!validSender(event))return {ok:false,code:'access_denied'};
    try{return {ok:true,value:await saveQrPng(args)};}catch(error){return resultError(error);}
  });
  ipcMain.handle('live-voice:readyToClose',event=>{if(validSender(event)&&closing)setImmediate(finishClose);return {ok:true,value:null};});
  window.on('close',event=>{
    if(finishing)return;
    event.preventDefault();
    if(closing)return;
    closing=true;
    window.webContents.send('live-voice:closing');
    closeTimer=setTimeout(finishClose,17000);
  });
  window.webContents.on('render-process-gone',()=>{void services?.dispose().catch(()=>undefined);});
  window.on('ready-to-show',()=>window.show());
  await window.loadURL(APP_URL);
  window.show();
}
const lock=app.requestSingleInstanceLock();
if(!lock)app.quit();
else{
  app.on('second-instance',()=>{if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}});
  app.whenReady().then(initialize).catch(()=>{
    dialog.showErrorBox('Live Voice','Unable to start the local application. / 无法启动本机应用，请检查应用文件及系统加密存储。');
    app.quit();
  });
  app.on('window-all-closed',()=>{void services?.dispose().catch(()=>undefined);app.quit();});
  app.on('before-quit',()=>{void services?.dispose().catch(()=>undefined);});
}
