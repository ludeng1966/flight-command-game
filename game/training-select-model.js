// 选关页的数据模型：只做"关卡 → 卡片 → 进入地址"的纯计算，方便测试，不碰 DOM。
import {TRAINING_LEVELS} from '../sim/training-levels.js';

export const RADAR_TUTORIAL = Object.freeze({
  number: 4,
  title: '紧急起飞识别',
  subtitle: '紧急起飞 · 雷达识别 · 返航',
  summary: '从跑道外紧急起飞，出航搜索不明目标，完成识别与 RWR 检查后返航。',
  url: './?tutorial=emergency',
  disabled: false
});

export function levelUrl(id) {
  return `./?training=guided&level=${encodeURIComponent(id)}`;
}

export function examUrl() {
  return './?training=exam';
}

export function menuUrl() {
  return './menu.html';
}

export function levelCards(progress = {}) {
  return TRAINING_LEVELS.map((level) => ({
    id: level.id,
    number: level.number,
    title: level.title,
    subtitle: level.subtitle,
    summary: level.summary,
    steps: level.missions.length,
    entry: level.entry,
    entryLabel: level.entry === 'airborne' ? '空中场景开始' : '从机位开始',
    passed: progress[level.id]?.passed === true,
    url: levelUrl(level.id)
  }));
}

export function radarTutorialCard() {
  return {...RADAR_TUTORIAL};
}
