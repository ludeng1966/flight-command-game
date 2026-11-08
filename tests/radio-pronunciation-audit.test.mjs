import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {radioPronunciationCorpus} from './helpers/radio-pronunciation-corpus.mjs';
import {normalizeAviationSpeech as speech} from '../sim/aviation-speech.js';
import {createGameServer,readConfig} from '../server/game-server.mjs';
import {createRadioConsole} from '../game/radio-console.js';
import {createInworldSpeech} from '../game/inworld-speech.js';
import {setLanguages} from '../game/language.js';
import {PILOT_DELIVERY} from '../server/bilingual-speech.mjs';
let corpus;
const getCorpus=()=>corpus??=radioPronunciationCorpus();

test('地面编号的前后置、组合、复数字段与已展开呼号保持同一读法',()=>{
  const cases=[
    ['Bravo 02，G2机位就绪。','Bravo TWO，GOLF TWO机位就绪。'],
    ['BRAVO ZERO TWO, ALPHA ZERO ONE.','BRAVO TWO, ALPHA ONE.'],
    ['A1滑行道关闭。','ALFA ONE滑行道关闭。'],
    ['A1、B1滑行道关闭。','ALFA ONE、BRAVO ONE滑行道关闭。'],
    ['经A、A1、AE1滑行至G2停机位。','经ALFA、ALFA ONE、ALFA ECHO ONE滑行至GOLF TWO停机位。'],
    ['滑行道P2和A1，停机位G2。','滑行道PAPA TWO和ALFA ONE，停机位GOLF TWO。'],
    ['TAXIWAYS A1 AND BE1, STANDS G1, G2.','TAXIWAYS ALFA ONE AND BRAVO ECHO ONE, STANDS GOLF ONE, GOLF TWO.'],
    ['STAND BY. GATE G2.','STAND BY. GATE GOLF TWO.']
  ];
  for(const locale of ['zh-CN','en-US'])for(const [source,expected]of cases){assert.equal(speech(source,locale),expected);assert.equal(speech(expected,locale),expected);}
  for(const source of ['F-16C，G力3.2，容量09L','TAXIWAY A1.5','STAND BY.','G2X机位，v.G2机位','APRON，H09L，R09L'])assert.equal(speech(source,'zh-CN'),source);
});

test('真实机场所有滑行道、机位、跑道均能规范播报，并且不改变数量和编号语义',async()=>{
  const {airport}=await getCorpus();
  for(const id of new Set(airport.edges.map(e=>e.name))){
    for(const source of [`${id}滑行道关闭`,`经滑行道${id}滑行`,`TAXIWAY ${id}.`]){
      const spoken=speech(source,'zh-CN');assert.notEqual(spoken,source,source);assert.equal(speech(spoken,'zh-CN'),spoken,source);
    }
  }
  for(const id of airport.stands){assert.match(speech(`${id}停机位就绪`,'zh-CN'),/GOLF/);assert(!speech(`${id}停机位就绪`,'zh-CN').includes(id));}
  for(const runway of airport.runways){
    const chinese=speech(`Bravo 02，${runway.designator}跑道外等待。`,'zh-CN');
    const english=speech(`BRAVO ZERO TWO, RUNWAY ${runway.designator}.`,'en-US');
    assert.match(chinese,/Bravo TWO/);assert.match(chinese,/[左右]/);assert.doesNotMatch(chinese,/ZERO|NINER|LEFT|RIGHT/);
    assert.match(english,/BRAVO TWO/);assert.match(english,/ZERO NINER|TWO SEVEN/);assert.match(english,/LEFT|RIGHT/);
  }
});

test('所有通联生成入口经过云端与本地播报规则，四种字幕/语音组合保留原字幕',async t=>{
  const {world,events,messages}=await getCorpus(),requests=[],local=[];
  assert(events.some(e=>e.text==='起飞许可 09L'));assert(events.some(e=>e.text==='接地，减速脱离跑道'));assert(events.some(e=>e.text==='已到达G2，刹车停车'));
  assert.deepEqual([...new Set(messages.map(m=>m.source))].sort(),['airport-phase','commander','manual-route','pilot-execution','pilot-readback','pilot-result','pilot-unable','radar']);
  const server=createGameServer(readConfig({INWORLD_API_KEY:'audit-test',INWORLD_VOICE_PILOT_1:'alpha-test',INWORLD_VOICE_PILOT_2:'bravo-test',INWORLD_PILOT_EN_LOCALIZED:'true'}),{fetchImpl:async(_url,options)=>{
    const request=JSON.parse(options.body);requests.push(request);return Response.json({audioContent:Buffer.from('ID3-audit').toString('base64')});
  }});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>{server.closeAllConnections();server.close();setLanguages({text:'zh',voice:'zh',rate:1});});
  class Audio{play(){this.onplaying?.();queueMicrotask(()=>this.onended?.());return Promise.resolve();}pause(){}removeAttribute(){}}
  const speechPlayer=createInworldSpeech({fetchImpl:(url,options)=>fetch(base+url,options),Audio,urlApi:{createObjectURL:()=> 'blob:audit',revokeObjectURL(){}}});
  const cloud=createRadioConsole({getWorld:()=>world,document:{querySelector:()=>null},speech:speechPlayer,storage:null});
  const native=createRadioConsole({getWorld:()=>world,provider:'browser',storage:null,document:{querySelector:()=>null},Utterance:class{constructor(text){this.text=text;}},synth:{
    getVoices:()=>[{lang:'zh-CN',localService:true},{lang:'en-US',localService:true}],cancel(){},speak(value){local.push(value.text);queueMicrotask(()=>value.onend());}
  }});
  let checked=0;
  for(const {message}of messages){
    const original=JSON.stringify(message);
    const combinations=message.texts?.en?[['zh','zh'],['zh','en'],['en','zh'],['en','en']]:[['zh','zh']];
    for(const [text,voice]of combinations){
      setLanguages({text,voice,rate:1});
      for(const radio of [cloud,native]){
        const start=requests.length,result=await radio.transmit(message);
        const request=requests.at(-1),raw=radio===cloud?request.text:local.at(-1);
        const spoken=radio===cloud&&request.modelId==='inworld-tts-2'?raw.slice(PILOT_DELIVERY.length).replace(/<lang lang="(?:zh-CN|en-US)">|<\/lang>/g,''):raw;
        if(radio===cloud)assert.equal(requests.length-start,1,'每条通联只能整句合成一次');
        assert.equal(result.delivery,'spoken');assert.equal(result.text,message.texts?.[text]??message.text);
        assert.equal(spoken,speech(result.speechText,result.speechLanguage));
        assert.doesNotMatch(spoken,/\b(?:ALPHA|BRAVO)\s+(?:0[12]|ZERO\s+(?:ONE|TWO))\b/i);
        assert.doesNotMatch(spoken,/\b(?:G[12]|A1|P2|09L|APRON|H09L|R09L)\b|→/);
        checked++;
      }
    }
    assert.equal(JSON.stringify(message),original);
  }
  assert(checked>100);
  t.diagnostic(JSON.stringify({sourceTypes:8,messages:messages.length,airportEvents:events.length,playbackChecks:checked}));
});
