// Exterior models only. One scene unit is one meter; no per-type display normalization.
export const AIRCRAFT_MODELS=Object.freeze({
  f16:{name:'F-16',asset:'f16',lengthM:15.027,wingspanM:9.449,heightM:5.09,body:0xb7c9d8,engines:[[0,-.05,5.6]],afterburner:true,source:'https://github.com/NikolaiVChr/f16',dimensionsSource:'https://view.ceros.com/lockheed-martin/f-16'},
  su27:{name:'Su-27',asset:'su27',lengthM:21.935,wingspanM:14.7,heightM:5.932,body:0x99b6ca,engines:[[-1.2,-.3,7.4],[1.2,-.3,7.4]],afterburner:true,source:'https://github.com/xcvb85/Su-27',dimensionsSource:'https://steamcdn-a.akamaihd.net/steam/apps/250310/manuals/DCS_Su-27_Flight_Manual_RU.pdf'},
  j11:{name:'J-11',asset:'su27',lengthM:21.935,wingspanM:14.7,heightM:5.932,body:0xaeb8bf,engines:[[-1.2,-.3,7.4],[1.2,-.3,7.4]],afterburner:true,source:'https://github.com/xcvb85/Su-27',sharedExterior:'Su-27 基础外形，未单独复刻 J-11 天线与航电外观细节'},
  b7478:{name:'Boeing 747-8I',asset:'b7478',lengthM:76.3,wingspanM:68.4,heightM:19.4,body:0xdbe4e9,engines:[],afterburner:false,source:'https://github.com/JMaverick16/747-8',dimensionsSource:'https://www.boeing.com/resources/boeingdotcom/company/about_bca/startup/pdf/historical/747-8I_-_passenger.pdf'},
  a320:{name:'Airbus A320-200',asset:'a320',lengthM:37.57,wingspanM:34.1,heightM:11.76,body:0xd1dce3,engines:[],afterburner:false,source:'https://github.com/legoboyvdlp/A320-family',dimensionsSource:'https://www.airbus.com/sites/g/files/jlcbta136/files/2023-05/Airbus-techdata-AC-A320_0523.pdf'}
});
export function aircraftModelId(unit){
  if(typeof unit==='string')return Object.hasOwn(AIRCRAFT_MODELS,unit)?unit:'f16';
  const id=unit?.visualModel??unit?.profile?.visualModel??unit?.profileId;
  return Object.hasOwn(AIRCRAFT_MODELS,id)?id:'f16';
}
