// 第 4 关「雷达入门」教学状态机：纯逻辑，不碰 DOM/渲染，便于测试。
// 步骤目标全部由真实雷达状态判定；只有判断题需要玩家选择。
export const RADAR_TUTORIAL_STEPS = [
  {id:'ready',kind:'brief',title:'雷达入门 · 空中出生',after:1.2,
    text:'你在一架 F-16 上，空中 6500 米。前方有两个练习靶机。本关只指挥 Alpha 一架飞机；用底部雷达快捷条和快捷键完成操作。'},
  {id:'search',kind:'goal',title:'第 1 步 · 开机搜索',goal:'search',
    text:'点按底部雷达模式按钮（或按住选 PD），让雷达开机。注意：开机需要约 2 秒预热，预热完才开始扇区搜索。'},
  {id:'contact',kind:'goal',title:'第 2 步 · 发现第一条航迹',goal:'contact',
    text:'等扫描线扫到目标。雷达屏（L）里出现航迹方框，就说明发现了目标；雷达不会告诉你它是什么型号。'},
  {id:'multi',kind:'goal',title:'第 3 步 · 两条航迹',goal:'multi',
    text:'继续等，两条练习靶都会出现在雷达上。多目标时用 R 轮换当前选中的航迹。'},
  {id:'lock',kind:'goal',title:'第 4 步 · 锁定目标',goal:'lock',
    text:'用 R 选中 TGT 01，按 E（或双击航迹）开始截获。截获需要连续回波，锁定成立后保持 2 秒。'},
  {id:'lost',kind:'goal',title:'第 5 步 · 观察丢锁',goal:'lost',
    text:'教官会把你锁定的靶机切成横切。PD 模式的速度门会把它当成地面杂波滤掉——注意看航迹变灰、进入外推，然后掉锁。'},
  {id:'mode',kind:'goal',title:'第 6 步 · 切换 SRC 模式',goal:'mode',
    text:'现在切到「SRC 脉冲」模式（按住模式按钮拖到右，或快速点按切换）。注意：切换模式会清空当前锁定和旧航迹；在这个低空杂波场景里，SRC 只作为对照，接下来要切回 PD。'},
  {id:'relock',kind:'goal',title:'第 7 步 · 重新截获',goal:'relock',
    text:'先切回 PD（点按模式按钮），靶机重新迎头后等 R 能选到航迹，再按 E 重新锁定。SRC 在这个有地面杂波的低空场景会被遮蔽，只用来对照。'},
  {id:'rcs',kind:'goal',title:'第 8 步 · RCS 与识别',goal:'identified',
    text:'这架 F-16 的雷达有 NCTR：持续锁定 4 秒、35 km 内，就会给出类别/型号和置信度。没有 NCTR 的雷达只能看到"一个目标"。'},
  {id:'rwr',kind:'goal',title:'第 9 步 · RWR 告警',goal:'rwr',
    text:'右上角打开 RWR（或看飞机外的 RWR 环）。教官会发射一个跟踪照射源；RWR 只给方位和等级，不给距离、位置或机型。'},
  {id:'silence',kind:'goal',title:'第 10 步 · 电磁静默',goal:'silence',
    text:'按住模式按钮拖到「电磁静默」松手。雷达关机、不再辐射；注意 RWR 环仍然收得到刚才的跟踪告警——静默不等于隐身。'},
  {id:'quiz',kind:'quiz',title:'最后一步 · 判断题',
    question:'横切目标为什么在 PD 模式下会丢锁？',
    options:[
      ['gate','进入地面杂波速度门，被当成杂波滤掉',''],
      ['range','超出了雷达探测距离','距离不是原因：目标仍在探测范围内。'],
      ['terrain','地形把它挡住了','地形遮挡是另一个原因；本题设定为横切进杂波门。']
    ],answer:'gate'}
];

export const TUTORIAL_LEVEL = Object.freeze({id:'radar',number:4,title:'雷达入门',entry:'airborne'});

const STEPS = RADAR_TUTORIAL_STEPS;
const stepId = (state) => STEPS[state.index]?.id ?? 'done';

export function createRadarTutorialState() {
  return {index:0,phase:'brief',startedAt:null,stableSec:0,lostSeen:false,feedback:'',hints:0,lastTime:null};
}

function fresh(unit, time) {
  const r = unit?.radar;
  if (!r) return [];
  return r.contacts.filter((c) => time - c.observedAt <= r.config.sweepSec + .25);
}

function lockedLongEnough(state, unit, time) {
  if (unit?.radar?.phase !== 'locked') { state.stableSec = 0; return false; }
  const dt = state.lastTime == null ? .05 : Math.max(0, time - state.lastTime);
  state.stableSec += dt;
  return state.stableSec >= 2;
}

// 进入某一步时执行的一次性设置（例如让练习靶横切/迎头）
export function enterRadarTutorialStep(state, unit, world) {
  const step = STEPS[state.index];
  state.phase = step?.kind === 'brief' ? 'brief' : 'working';
  state.startedAt = world.time;
  state.stableSec = 0;
  state.feedback = '';
  state.lostBase = unit?.radar?.lastLostSequence ?? 0;
  if (!step) return;
  try {
    if (step.id === 'lost') {
      const id = unit?.radar?.targetId;
      if (id) world.setRadarPracticeAspect?.(unit.id, id, 'crossing');
    }
    if (step.id === 'rwr') {
      world.addRwrPracticeEmitter?.(unit.id, 'track');
    }
    if (step.id === 'relock') {
      // 重新截获时让练习靶与本机同速同向：相对距离稳定，PD 下可见，不会被速度门当成横切。
      for (const target of world.radarTargets ?? []) {
        if (target.alive !== false) target.velocity = [...unit.velocity];
      }
    }
  } catch { /* 场景没有演练靶时忽略 */ }
}

export function advanceRadarTutorial(state, unit, world) {
  if (state.phase !== 'success') return false;
  state.index++;
  if (state.index >= STEPS.length) { state.phase = 'done'; return false; }
  enterRadarTutorialStep(state, unit, world);
  return true;
}

export function answerRadarTutorial(state, value) {
  const step = STEPS[state.index];
  if (!step || step.kind !== 'quiz' || state.phase === 'success') return null;
  const option = step.options.find((o) => o[0] === value);
  if (!option) return null;
  if (value === step.answer) { state.phase = 'success'; state.feedback = '答对了：横切目标的杂波速度差落进 ±80 m/s 门内，被 PD 当成地面杂波滤掉。'; return true; }
  state.feedback = option[2] || '再想想。';
  return false;
}

export function tickRadarTutorial(state, unit, world) {
  const step = STEPS[state.index];
  if (!step || state.phase === 'success' || state.phase === 'done') return state;
  const now = world.time;
  if (state.phase === 'brief') {
    if (now - state.startedAt >= (step.after ?? 1)) state.phase = 'success';
    state.lastTime = now;
    return state;
  }
  const radar = unit?.radar;
  if (!radar) return state;
  let passed = false;
  const contacts = fresh(unit, now);
  switch (step.goal) {
    case 'search': passed = radar.mode !== 'off' && ['search','acquiring','locked','coasting'].includes(radar.phase); break;
    case 'contact': passed = contacts.length >= 1 || radar.phase === 'locked'; break;
    case 'multi': passed = contacts.length >= 2 || radar.contacts.length >= 2; break;
    case 'lock': passed = lockedLongEnough(state, unit, now); break;
    case 'mode': passed = radar.mode === 'pulse'; break;
    case 'lost':
      if (radar.phase === 'coasting') state.lostSeen = true;
      passed = state.lostSeen || (radar.lastLostSequence ?? 0) > (state.lostBase ?? 0);
      break;
    case 'relock': passed = radar.phase === 'locked' && !!radar.targetId && now - state.startedAt >= 1; break;
    case 'silence': passed = radar.silent === true; break;
    case 'identified': passed = contacts.some((c) => c.identification) || (unit.radar?.contacts ?? []).some((c) => c.identification); break;
    case 'rwr': passed = (unit.rwr?.contacts ?? []).some((c) => now - c.observedAt <= 2.5); break;
    default: passed = false;
  }
  if (passed) { state.phase = 'success'; state.feedback = ''; }
  else if (now - state.startedAt > 15 && state.hints < 3) {
    state.hints++;
    state.feedback = hintFor(step.goal, unit);
  }
  state.lastTime = now;
  return state;
}

function hintFor(goal, unit) {
  const r = unit?.radar;
  switch (goal) {
    case 'search': return '提示：底部雷达按钮点一下切 PD；如果显示"预热中"，等约 2 秒。';
    case 'contact': return '提示：雷达在扇区扫描，稍等几秒；按 B 打开雷达屏看扫描线。';
    case 'multi': return '提示：两个靶机都在前方，等第二圈扫描；R 可轮换选中的航迹。';
    case 'lock': return `提示：用 R 选中一条航迹${r?.contacts?.length ? '' : '（先发现目标）'}，再按 E；锁定后保持 2 秒。`;
    case 'mode': return '提示：按住模式按钮拖到「SRC 脉冲」再松手；快速点按也可以切到 SRC。';
    case 'lost': return '提示：保持锁定，等教官把靶机切成横切；盯住雷达屏变灰/外推。';
    case 'relock': return '提示：等回波恢复，再按 E；若已解锁，先等搜索到航迹。';
    case 'rwr': return '提示：点右上角 RWR 打开平面告警屏；雷达环上的菱形就是跟踪告警。';
    case 'silence': return '提示：按住模式按钮拖到「电磁静默」松手。';
    case 'identified': return '提示：保持锁定，等 4 秒积累；不够距离或没开 NCTR 时不会出机型。';
    default: return '';
  }
}

export function currentRadarTutorialStep(state) { return STEPS[state.index] ?? null; }
