import React, {useEffect,useState} from 'react';
import {AppRegistry,DeviceEventEmitter,Text,View} from 'react-native';
// Simulator-only harness: production UI with synthetic storage/session/audio.
const storage=require('../../src/storage');
let settings={locale:'zh',theme:'light',mode:'general',recordingEnabled:true,voice:{voice:'marin',tone:'natural',intonation:'natural',pace:'normal',minutes:10,instructions:''},backend:{enabled:false,effort:'low',maxOutputTokens:32768,webSearch:true,timeoutSeconds:60,instructions:''}};
const connection={endpoint:'https://synthetic.example.test/v1',model:'gpt-live-1',auth:'bearer',keyMask:'test••••key'};
storage.loadSettings=async()=>settings;storage.saveSettings=async(value:any)=>{settings=value;};
storage.loadConnections=async()=>({voice:connection,backend:null});storage.getCredential=async()=>({...connection,apiKey:'synthetic-only'});storage.loadHistory=async()=>[];storage.saveRecord=async()=>[];
const audio=require('../../src/audio');audio.observeAudioRoute=()=>()=>{};for(const k of ['requestAudioPermission','markAudioConnected','startAudio','stopAudio'])audio[k]=async()=>{};
const rec=require('../../src/recordings');rec.recordingAvailable=()=>true;
rec.recordings={...rec.recordings,list:async()=>({items:[],hasMore:false}),status:async()=>({state:'idle'}),stopPlayback:async()=>{}};
require('../../src/recording-session').createRecordingSession=()=>({start:async()=>{},connected(){},finish:async()=>null});
require('../../src/session-activity').sessionActivity={start:async()=>false,update:async()=>{},end:async()=>{}};
let failOnce=true;
require('../../src/live').createLiveController=(callbacks:any)=>({connect:async()=>{callbacks.onStatus('connecting');callbacks.onStatus('connected');callbacks.onTranscript({role:'assistant',text:'Synthetic transcript remains visible.',startMs:0,endMs:1000});callbacks.onSources(Array.from({length:12},(_,i)=>({title:'Synthetic source '+(i+1),url:'https://example.test/source/'+(i+1)})));},close:async()=>{callbacks.onStatus('closing');callbacks.onClosed(true);return true;},dispose(){},setMuted(){},appendStyle:async()=>{},updatePreferences:async(value:any)=>{if(value.voice?.instructions?.includes('FAIL_ONCE')&&failOnce){failOnce=false;throw Error('command_timeout');}DeviceEventEmitter.emit('HarnessApplied',value.voice?('Applied: '+value.voice.tone+' | '+value.voice.instructions):('Backend applied: '+value.backend.maxOutputTokens));}});
const App=require('../../App').default;
function Harness(){const [applied,setApplied]=useState('');useEffect(()=>{const s=DeviceEventEmitter.addListener('HarnessApplied',setApplied);return()=>s.remove();},[]);return <View style={{flex:1}}><Text>Settings lock harness</Text>{!!applied&&<Text>{applied}</Text>}<App /></View>;}
AppRegistry.registerComponent('LiveVoiceApp',()=>Harness);
