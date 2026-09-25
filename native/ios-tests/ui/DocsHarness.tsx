import React from 'react';
import {AppRegistry,Text,View} from 'react-native';

// Documentation only. All state and credentials are synthetic; no model calls.
const storage = require('../../src/storage');
let settings = {locale:'zh',theme:'light',mode:'general',recordingEnabled:true,
  voice:{voice:'marin',tone:'natural',intonation:'natural',pace:'normal',minutes:10,instructions:''},
  backend:{enabled:true,effort:'low',maxOutputTokens:32768,webSearch:true,timeoutSeconds:60,instructions:''}};
const connections = {
  voice:{endpoint:'https://voice.example.test/openai/v1',model:'gpt-live-1',auth:'api-key',keyMask:'demo••••voice'},
  backend:{endpoint:'https://llm.example.test/openai/v1',model:'gpt-5.6',auth:'api-key',keyMask:'demo••••llm'},
};
storage.loadSettings=async()=>settings;
storage.saveSettings=async(value:any)=>{settings=value;};
storage.loadConnections=async()=>connections;
storage.getCredential=async(kind:'voice'|'backend')=>({...connections[kind],apiKey:'documentation-only'});
storage.loadHistory=async()=>[];
const audio=require('../../src/audio');audio.observeAudioRoute=()=>()=>{};
const rec=require('../../src/recordings');rec.recordingAvailable=()=>true;
rec.recordings={...rec.recordings,list:async()=>({items:[],hasMore:false}),status:async()=>({state:'idle'}),stopPlayback:async()=>{}};
require('../../src/session-activity').sessionActivity={start:async()=>false,update:async()=>{},end:async()=>{}};
require('../../src/live').createLiveController=()=>{throw Error('Documentation demo does not connect');};
const App=require('../../App').default;
function DocsHarness(){return <View style={{flex:1}}><App/><Text pointerEvents="none" style={{position:'absolute',bottom:74,right:16,fontSize:10,color:'#777',backgroundColor:'#faf8f3',padding:4}}>演示数据 / Demo data</Text></View>;}
AppRegistry.registerComponent('LiveVoiceApp',()=>DocsHarness);
