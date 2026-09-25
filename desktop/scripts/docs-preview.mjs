import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';

// Real renderer, in-memory synthetic state. Never loads the desktop credential store.
const renderer = new URL('../dist/renderer/', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const fixture = `
let settings={locale:'zh',theme:'light',mode:'general',audio:{inputDeviceId:'',outputDeviceId:''},voice:{voice:'marin',tone:'natural',intonation:'natural',pace:'normal',minutes:10,instructions:''},backend:{enabled:true,effort:'low',maxOutputTokens:32768,webSearch:true,timeoutSeconds:60,instructions:''}};
const connections={voice:{endpoint:'https://voice.example.test/openai/v1',model:'gpt-live-1',auth:'api-key',keyMask:'demo••••voice'},backend:{endpoint:'https://llm.example.test/openai/v1',model:'gpt-5.6',auth:'api-key',keyMask:'demo••••llm'}};
const ok=value=>Promise.resolve({ok:true,value});
window.liveVoice={bootstrap:()=>ok({settings,connections,history:[],version:${JSON.stringify(pkg.version)}}),saveSettings:async({settings:value})=>{settings=value;return {ok:true,value:settings};},onClosing:()=>()=>{},readyToClose:()=>ok(null),cancelTest:()=>ok(null),testConnection:()=>Promise.resolve({ok:false,code:'cancelled'}),createSession:()=>Promise.resolve({ok:false,code:'cancelled'})};
document.addEventListener('DOMContentLoaded',()=>{const badge=document.createElement('span');badge.className='docs-demo';badge.textContent='演示数据 / Demo data';document.body.append(badge);});
`;
const types={'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png'};
const assets=new Set(['index.html','app.js','styles.css','logo.png']);
const port=Number(process.env.DOCS_PREVIEW_PORT||8794);
createServer(async(req,res)=>{
  const name=req.url==='/'?'index.html':req.url?.slice(1);
  if(name==='favicon.ico'){res.writeHead(204).end();return;}
  if(name==='fixture.js'){res.writeHead(200,{'Content-Type':'text/javascript'}).end(fixture);return;}
  if(!assets.has(name)){res.writeHead(404).end();return;}
  try {
    let data=await readFile(new URL(name,renderer));
    if(name==='index.html')data=Buffer.from(data.toString().replace("frame-ancestors 'none'",'').replace('<script type="module" src="app.js">','<script src="fixture.js"></script><script type="module" src="app.js">'));
    if(name==='styles.css')data=Buffer.concat([data,Buffer.from('\n.docs-demo{position:fixed;right:16px;bottom:8px;font:11px system-ui;color:#777;background:#faf8f3;padding:3px 6px;border-radius:4px;pointer-events:none;z-index:100;}')]);
    res.writeHead(200,{'Content-Type':types[name.slice(name.lastIndexOf('.'))],'Cache-Control':'no-store'}).end(data);
  } catch {res.writeHead(500).end();}
}).listen(port,'127.0.0.1',()=>console.log('Documentation renderer ready; synthetic data only.'));
