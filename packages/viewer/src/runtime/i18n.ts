/**
 * Viewer runtime i18n helper
 *
 * 浏览器端翻译函数,从 window.CO_ENGRAM_I18N({zh, en}) 读取翻译表,
 * 当前语言由 window.CO_ENGRAM_LANG 决定。提供:
 *   - CO_ENGRAM_T.t(key, vars?):通用翻译
 *   - CO_ENGRAM_T.enumLabel(category, value):枚举显示(如 'kind', 'fact')
 *   - CO_ENGRAM_T.fieldLabel(name):字段标签(如 'time', 'id')
 *   - CO_ENGRAM_T.decayLabel(days):衰退倒计时文案
 *
 * 与 core 的 t() 语义一致:fallback 顺序为目标语言 → 英文 → key 本身。
 *
 * @module @co-engram/viewer/runtime/i18n
 */

export const I18N_RUNTIME = `
// ============================================================
// Co-Engram Viewer i18n helper(浏览器端,挂在 window.CO_ENGRAM_T)
// ============================================================
window.CO_ENGRAM_T = (function() {
  'use strict';

  const DICTS = (window.CO_ENGRAM_I18N || { zh: {}, en: {} });
  const LANG = window.CO_ENGRAM_LANG || 'en';

  function dictFor(lang) {
    return DICTS[lang] || {};
  }

  function t(key, vars) {
    const mainDict = dictFor(LANG);
    const enDict = dictFor('en');
    const template = mainDict[key] || enDict[key] || key;
    if (!vars) return template;
    return template.replace(/\\$\\{(\\w+)\\}/g, function(_, name) {
      return vars[name] !== undefined ? String(vars[name]) : '\\${" + name + "}';
    });
  }

  function enumLabel(category, value) {
    if (!value) return t('common.unknown');
    return t('enum.' + category + '.' + value);
  }

  function fieldLabel(name) {
    return t('field.label.' + name);
  }

  function sectionLabel(name) {
    return t('section.' + name);
  }

  function actionLabel(name) {
    return t('action.' + name);
  }

  function decayLabel(days) {
    if (days === null || days === undefined) return t('decay.forgotten');
    return t('decay.daysToNext', { days: days });
  }

  // 把裸浮点 score 格式化为 '0.72 · 高' 形式:
  //   - 2 位小数(杀 0.018000000000000002 类浮点噪声)
  //   - band: ≥0.7 high / ≥0.3 medium / <0.3 low(与 core formatScoreField 阈值一致)
  //   - null/undefined/NaN 返回 '—'
  function formatScoreBand(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    var rounded = Math.round(value * 100) / 100;
    var band = rounded >= 0.7 ? 'high' : rounded >= 0.3 ? 'medium' : 'low';
    return rounded.toFixed(2) + ' · ' + t('viewer.scoreBand.' + band);
  }

  function currentLang() {
    return LANG;
  }

  return {
    t: t,
    enumLabel: enumLabel,
    fieldLabel: fieldLabel,
    sectionLabel: sectionLabel,
    actionLabel: actionLabel,
    decayLabel: decayLabel,
    formatScoreBand: formatScoreBand,
    currentLang: currentLang,
  };
})();
`;
