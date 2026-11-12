import {levelCards, radarTutorialCard, examUrl, menuUrl} from './training-select-model.js';
import {loadProgress} from './training-store.js';

const cards = document.getElementById('level-cards');
const exam = document.getElementById('exam-link');

function cardHTML(card) {
  const state = card.passed ? '<span class="state passed">✓ 已通过</span>' : '<span class="state">可开始</span>';
  return `<article class="level-card">
    <div class="level-top"><span>第 ${card.number} 关</span>${state}</div>
    <h2>${card.title}</h2>
    <p>${card.subtitle}</p>
    <p class="meta">${card.steps} 个短步骤 · ${card.entryLabel}</p>
    <a class="go" href="${card.url}">${card.passed ? `重新练习第 ${card.number} 关` : `进入第 ${card.number} 关`}</a>
  </article>`;
}

function radarCardHTML(card) {
  return `<article class="level-card">
    <div class="level-top"><span>第 ${card.number} 关</span><span class="state">新增</span></div>
    <h2>${card.title}</h2>
    <p>${card.subtitle}</p>
    <p class="meta">${card.summary}</p>
    <a class="go" href="${card.url}">进入第 ${card.number} 关</a>
  </article>`;
}

const progress = loadProgress().levelProgress ?? {};
cards.innerHTML = levelCards(progress).map(cardHTML).join('') + radarCardHTML(radarTutorialCard());
exam.href = examUrl();
document.querySelector('.back').href = menuUrl();
