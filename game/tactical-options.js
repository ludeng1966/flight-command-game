export const ATTACK_METHODS={
  auto:{zh:'飞行员自主选弹',en:'Pilot weapon choice',weaponRef:null},
  radar:{zh:'雷达弹攻击',en:'Radar missile attack',weaponRef:'雷达导弹'},
  infrared:{zh:'红外弹攻击',en:'Infrared missile attack',weaponRef:'infrared'}
};
export const DEFENSE_METHODS={notch:{zh:'横切规避',en:'Beam / notch'},extend:{zh:'背向脱离',en:'Turn cold / extend'}};
export const DEFENSE_SIDES={auto:{zh:'就近转向',en:'Nearest turn'},left:{zh:'左转',en:'Turn left'},right:{zh:'右转',en:'Turn right'}};
export function tacticalOptions(input={}){
  const result={attackMethod:input.attackMethod??'auto',defenseMethod:input.defenseMethod??'notch',defenseSide:input.defenseSide??'auto'};
  if(!Object.hasOwn(ATTACK_METHODS,result.attackMethod)||!Object.hasOwn(DEFENSE_METHODS,result.defenseMethod)||!Object.hasOwn(DEFENSE_SIDES,result.defenseSide))throw Error('快捷命令方式无效');
  return result;
}
