import React, {useState} from 'react';
import {AppRegistry,Button,NativeModules,Text,View} from 'react-native';
function Harness(){const [result,setResult]=useState('Audio routing harness');
 async function run(){try{const audio=NativeModules.VoiceAudio;await audio.start();await audio.conversationConnected();const route=await audio.getRoute();const counters=await audio.diagnosticAudio();await audio.stop();const stopped=await audio.getRoute();if(route.automatic!==true||!['speaker','receiver','headphones','bluetooth','system'].includes(route.output)||stopped.output!=='system'||counters.micFrames!==0)throw Error('invalid');setResult('Automatic routing bridge passed: '+route.output);}catch{await NativeModules.VoiceAudio.stop();setResult('Audio routing test failed');}}
 return <View style={{flex:1,padding:50,backgroundColor:'white'}}><Text>{result}</Text><Button title="Verify automatic routing" onPress={()=>void run()}/></View>;
}
AppRegistry.registerComponent('LiveVoiceApp',()=>Harness);
