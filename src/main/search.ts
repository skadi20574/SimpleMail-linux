/**
 * 主进程侧的搜索工具：实现全部集中在 `@shared/search-terms`，
 * 这里只做一次转发，好让主进程代码保持 `./search` 这样简短的导入路径，
 * 同时保证渲染进程高亮时用的是**同一套切词规则**。
 */

export {
  hasCjk,
  buildCjkIndexText,
  buildMatchQuery,
  buildMatchQueryMulti,
  splitHighlightTerms,
  splitHighlightTermsMulti,
  hasAnyCriteria,
  countCriteria,
  describeCriteria,
  compactCriteria,
  SEARCH_CRITERIA_FIELDS
} from '@shared/search-terms'
