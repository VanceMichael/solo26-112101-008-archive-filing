/**
 * 册页引用：外部输入为 `档号/页号`（如 OD-5/2），扫描件内另有册页坐标（如 FR-4/2）。
 * 两类引用不可混用——档号页用于门户领件，册页坐标用于扫描包核对。
 */

/** 解析 `档号/页号`，页号允许字母后缀（如 OD-5/3a 表示补发页）。 */
export function parseFolio(text) {
  const match = /^([A-Za-z0-9-]+)\/([0-9]+[A-Za-z]*)$/.exec(String(text).trim());
  if (!match) throw new TypeError(`非法档页引用：${text}`);
  return { archiveNo: match[1], page: match[2] };
}

export function formatFolio({ archiveNo, page }) {
  return `${archiveNo}/${page}`;
}

/** 解析扫描件册页坐标（FR-4/2），与档页引用区分开。 */
export function parseSheetRef(text) {
  const match = /^([A-Za-z0-9-]+)\/([0-9]+[A-Za-z]*)$/.exec(String(text).trim());
  if (!match) throw new TypeError(`非法册页坐标：${text}`);
  return { volume: match[1], sheet: match[2] };
}

/** 展开 `FR-4/1–3` 一类的区间为逐页坐标（仅用于索引展示与提示，不自动获得授权）。 */
export function expandSheetRange(text) {
  const match = /^([A-Za-z0-9-]+)\/(\d+)\s*[–-]\s*(\d+)$/.exec(String(text).trim());
  if (!match) return [text];
  const [, volume, start, end] = match;
  const first = Number(start);
  const last = Number(end);
  if (last < first) return [text];
  return Array.from({ length: last - first + 1 }, (_, index) => `${volume}/${first + index}`);
}
