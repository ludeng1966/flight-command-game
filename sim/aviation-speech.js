import {airportModeLabel} from './airport-language.js';
// Speech-only lexicon. Never use this text to parse orders or render subtitles.
export const AVIATION_PRONUNCIATION=Object.freeze({
  zhDigits:'洞幺两三四五六拐八九',
  enDigits:['ZERO','ONE','TWO','THREE','FOUR','FIVE','SIX','SEVEN','EIGHT','NINER'],
  suffixes:{L:{zh:'左',en:'LEFT'},R:{zh:'右',en:'RIGHT'},C:{zh:'中',en:'CENTER'}},
  letters:['ALFA','BRAVO','CHARLIE','DELTA','ECHO','FOXTROT','GOLF','HOTEL','INDIA','JULIETT','KILO','LIMA','MIKE','NOVEMBER','OSCAR','PAPA','QUEBEC','ROMEO','SIERRA','TANGO','UNIFORM','VICTOR','WHISKEY','X-RAY','YANKEE','ZULU'],
  terms:{ILS:{zh:'仪表着陆系统',en:'I L S'},DME:{zh:'测距仪',en:'D M E'},VOR:{zh:'甚高频全向信标',en:'V O R'},ATC:{zh:'空中交通管制',en:'A T C'},ATIS:{zh:'自动终端情报服务',en:'A T I S'},IFR:{zh:'仪表飞行规则',en:'I F R'},VFR:{zh:'目视飞行规则',en:'V F R'}}
});
const lexicon=AVIATION_PRONUNCIATION;
const callsignNames=[...lexicon.letters,'ALPHA'].join('|');
const namedCallsign=new RegExp('\\b('+callsignNames+')\\s*[- ]\\s*(\\d{1,4})(?![A-Za-z0-9])','gi');
const digitWords=[...lexicon.enDigits,'NINE','OH'].join('|');
const spokenCallsign=new RegExp('\\b('+callsignNames+')\\s+((?:'+digitWords+')(?:\\s+(?:'+digitWords+')){0,3})(?![A-Za-z0-9])','gi');
// Only labelled ground identifiers are expanded. In particular, STAND BY,
// model F-16C and the internal graph node H09L must never become ground codes.
const groundCode='(?:[A-Z]{1,2}\\d{1,2}|[A-Z])';
const groundList=groundCode+'(?:\\s*(?:[,、/→]|\\band\\b|\\bthen\\b|和|及|与)\\s*'+groundCode+')*';
const groundToken=new RegExp('(?<![A-Za-z0-9_.+\\-])'+groundCode+'(?![A-Za-z0-9_+\\-]|\\.\\d)','gi');
const groundPrefix=new RegExp('((?:滑行道|沿|经由|经|机位|\\bTAXIWAYS?\\b|\\bVIA\\b|\\bSTANDS?\\b|\\bGATES?\\b)\\s*)('+groundList+')(?![A-Za-z0-9_+\\-]|\\.\\d)','gi');
const groundSuffix=new RegExp('(?<![A-Za-z0-9_.+\\-])('+groundList+')(?=\\s*(?:滑行道|停机位|机位))','gi');
function digits(value,en){return String(value).split('').map(c=>lexicon.enDigits[Number(c)]&&(en?lexicon.enDigits[Number(c)]:lexicon.zhDigits[Number(c)])||c).join(en?' ':'');}
const validRunway=value=>Number(value)>=1&&Number(value)<=36;
const runway=(value,suffix,en)=>digits(String(value).padStart(2,'0'),en)+(suffix?(en?' ':'')+lexicon.suffixes[suffix.toUpperCase()][en?'en':'zh']:'');
function code(value){return value.toUpperCase().replace(/[A-Z]/g,c=>lexicon.letters[c.charCodeAt(0)-65]+' ').replace(/\d+/g,n=>digits(n,true)).trim();}
export function normalizeAviationSpeech(input,language){
  const en=language?/^en(?:-|$)/i.test(language):!/[\u3400-\u9fff]/.test(input);
  let text=input;
  text=text.replace(/(起飞|着陆|降落|滑行|复飞)\s*[/／]\s*(TAKE\s?OFF|LAND(?:ING)?|TAXI|GO[ _-]?AROUND)/gi,(_,zh,english)=>en?english.replaceAll('_',' ').toUpperCase():zh);
  text=text.replace(/(?<![A-Za-z0-9_])(reduced_thrust|full_thrust|military_power|afterburner|derated|flex)(?![A-Za-z0-9_])/g,mode=>airportModeLabel(mode,'takeoff',en?'en':'zh')??mode);
  // Explicit labels also admit unpadded runway numbers. Bare identifiers require
  // two digits, valid range, and word boundaries so F-16C/0.09L remain untouched.
  text=text.replace(/\b(?:RUNWAY|RWY)\s*([0-3]?\d)(?:\s*-?\s*([LRC]))?(?![A-Za-z0-9.])/gi,(all,n,suffix)=>validRunway(n)?`${en?'RUNWAY ':'跑道'}${runway(n,suffix,en)}`:all);
  text=text.replace(/(跑道\s*)([0-3]?\d)\s*-?\s*([LRC])(?![A-Za-z0-9])/gi,(all,label,n,suffix)=>validRunway(n)?label+runway(n,suffix,en):all);
  text=text.replace(/(?<![A-Za-z0-9_.+\-])([0-3]?\d)\s*-?\s*([LRC])(?=\s*(?:跑道|等待点))/gi,(all,n,suffix)=>validRunway(n)?runway(n,suffix,en):all);
  text=text.replace(/(?<![A-Za-z0-9_.+\-])([0-3]\d)\s*-?\s*([LRC])(?![A-Za-z0-9])/gi,(all,n,suffix,offset,source)=>{
    const before=source.slice(Math.max(0,offset-20),offset);
    if(!validRunway(n)||/(?:容量|体积|加注|油量|燃油|volume|fuel)\s*$/i.test(before))return all;
    return runway(n,suffix,en);
  });
  text=text.replace(/(跑道\s*)([0-3]?\d)(?![\d.A-Za-z])/g,(all,label,n)=>validRunway(n)?label+runway(n,null,en):all);
  text=text.replace(/(?<![A-Za-z0-9_.+\-])([0-3]?\d)(?=\s*跑道)/g,(all,n)=>validRunway(n)?runway(n,null,en):all);
  text=text.replace(/((?:航向|方位|航道)\s*)(\d{1,3})(?![\d.])/g,(all,label,n)=>Number(n)<=360?label+digits(String(n).padStart(3,'0'),en):all);
  text=text.replace(/\b(HEADING|BEARING|COURSE)\s+(\d{1,3})(?![\d.])/gi,(all,label,n)=>Number(n)<=360?label+' '+digits(String(n).padStart(3,'0'),en):all);
  // Callsign suffixes are English identifiers in either language. Their leading
  // zero is display padding (ALPHA 01 -> ALPHA ONE), unlike runway 09 -> 洞九.
  text=text.replace(namedCallsign,(_,call,n)=>call+' '+digits(String(Number(n)),true));
  text=text.replace(spokenCallsign,(_,call,value)=>{
    const words=value.toUpperCase().split(/\s+/);
    while(words.length>1&&['ZERO','OH'].includes(words[0]))words.shift();
    return call+' '+words.map(word=>word==='OH'?'ZERO':word==='NINE'?'NINER':word).join(' ');
  });
  text=text.replace(groundPrefix,(_,label,route)=>label+route.replace(groundToken,code));
  text=text.replace(groundSuffix,route=>route.replace(groundToken,code));
  text=text.replace(/(?<![A-Za-z0-9_])(ILS|DME|VOR|ATC|ATIS|IFR|VFR)(?![A-Za-z0-9_])/g,term=>lexicon.terms[term][en?'en':'zh']);
  return text;
}
