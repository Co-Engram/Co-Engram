/**
 * Viewer runtime decay visualizer
 *
 * 浏览器端衰退状态计算 + 进度条 DOM 生成。
 * 镜像 core/src/lifecycle/freshness.ts:30 的 computeFreshness 阈值:
 *   ageDays <= halfLife      -> fresh
 *   ageDays <= halfLife * 2  -> aging
 *   ageDays <= halfLife * 4  -> stale
 *   ageDays >  halfLife * 4  -> forgotten
 *
 * 进度条分母用 halfLife*4(完整衰退周期),让用户直观看到"还能撑多久才 forgotten"。
 *
 * @module @co-engram/viewer/runtime/decay
 */

export const DECAY_RUNTIME = `
// ============================================================
// Co-Engram Viewer decay visualizer
// ============================================================
window.CO_ENGRAM_DECAY = (function() {
  'use strict';

  function computeDecayState(lastEffectiveAt, createdAt, halfLifeDays, now) {
    const nowMs = (now || new Date()).getTime();

    // 永不衰退
    if (halfLifeDays === null || halfLifeDays === undefined || halfLifeDays <= 0) {
      return null;
    }

    // 衰退起点 = lastEffectiveAt ?? createdAt(未生效用创建时间)
    // 与 core/src/lifecycle/freshness.ts:effectiveAge 保持一致:
    //   优先 lastEffectiveAt(若为合法时间戳);否则 fallback createdAt;两者都损坏返回 null
    var lastEffMs = lastEffectiveAt ? new Date(lastEffectiveAt).getTime() : NaN;
    var createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
    var refMs = !isNaN(lastEffMs) ? lastEffMs : createdMs;
    if (isNaN(refMs)) {
      return null;
    }

    let ageMs = nowMs - refMs;
    if (ageMs < 0) {
      // 时钟偏差(极少见):视为 fresh,ageDays=0
      ageMs = 0;
    }
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const halfLife = halfLifeDays;

    let currentLevel;
    let daysToNext;
    if (ageDays <= halfLife) {
      currentLevel = 'fresh';
      daysToNext = Math.max(0, Math.ceil(halfLife - ageDays));
    } else if (ageDays <= halfLife * 2) {
      currentLevel = 'aging';
      daysToNext = Math.max(0, Math.ceil(halfLife * 2 - ageDays));
    } else if (ageDays <= halfLife * 4) {
      currentLevel = 'stale';
      daysToNext = Math.max(0, Math.ceil(halfLife * 4 - ageDays));
    } else {
      currentLevel = 'forgotten';
      daysToNext = null;
    }

    // 进度条:0-100,基于 halfLife*4 作完整周期
    const totalCycle = halfLife * 4;
    const progressPct = Math.max(0, Math.min(100, (ageDays / totalCycle) * 100));

    return {
      progressPct: progressPct,
      currentLevel: currentLevel,
      daysToNext: daysToNext,
    };
  }

  function renderDecayBar(decay, halfLifeDays) {
    const T = window.CO_ENGRAM_T;
    if (!decay) {
      // 永不衰退(decayHalfLifeDays=null) — 加 title 悬停解释成因
      const tipText = T.t('decay.neverDecaysTip');
      const titleAttr = (tipText && tipText !== 'decay.neverDecaysTip') ? ' title="' + tipText.replaceAll('"', '&quot;') + '"' : '';
      return '<div class="decay-empty"' + titleAttr + '>' + T.t('decay.neverDecays') + '</div>';
    }

    const colorClass = 'freshness-' + decay.currentLevel;
    const countdown = T.decayLabel(decay.daysToNext);
    const levelText = T.enumLabel('freshness', decay.currentLevel);

    return ''
      + '<div class="decay-row">'
      +   '<span class="decay-level freshness-' + decay.currentLevel + '">' + levelText + '</span>'
      +   '<span class="decay-countdown">' + countdown + '</span>'
      + '</div>'
      + '<div class="decay-bar" title="' + T.t('field.label.decayProgress') + '">'
      +   '<div class="decay-fill ' + colorClass + '" style="width:' + decay.progressPct.toFixed(1) + '%"></div>'
      + '</div>';
  }

  return {
    computeDecayState: computeDecayState,
    renderDecayBar: renderDecayBar,
  };
})();
`;
