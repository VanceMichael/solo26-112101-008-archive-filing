/**
 * 旧门户 HTML 解析。门户只提供本地浏览器界面，没有 JSON API，
 * 这里用容错的正则/标签解析把页面转成领域数据；解析失败显式报错，不猜测。
 */
import { PortalContractError } from '../domain/errors.js';
import { expandSheetRange } from '../domain/folio.js';

const stripTags = html => html
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** 入口页：回显查询表单的机关与字段，确认浏览器会话可用。 */
export function parseArchiveHome(html) {
  if (!html.includes('档案调阅') || !html.includes('name="office"')) {
    throw new PortalContractError('档案调阅入口页结构异常');
  }
  const offices = [...html.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)]
    .map(match => ({ code: match[1], label: match[2] }));
  return { title: '档案调阅', offices };
}

/**
 * 查询结果页：
 *  - 标题含查询任务号（如 原机关查询 Q7）；
 *  - 状态短语：检索仍在出页 / 索引已封；
 *  - 表格行：档号 / 归属 / 册页 / 来源；
 *  - 领件表单给出该页当前允许的 folio 与服务端校验值。
 */
export function parseSearchPage(html) {
  const heading = html.match(/<h1>([^<]+查询\s*([A-Za-z0-9-]+))<\/h1>/);
  if (!heading) throw new PortalContractError('查询页缺少任务标题');
  const taskNo = heading[2];
  // 单条企业提示页不带状态短语，视为已封（内容已完整给出）。
  const status = html.includes('索引已封')
    ? 'SEALED'
    : html.includes('检索仍在出页')
      ? 'STREAMING'
      : html.includes('企业') && html.includes('档页')
        ? 'SEALED'
        : (() => { throw new PortalContractError('查询页缺少索引状态短语'); })();

  const rows = [...html.matchAll(/<tr><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><td>([^<]+)<\/td><\/tr>/g)]
    .map(match => ({
      archiveNo: match[1].trim(),
      subject: match[2].trim(),
      sheetRange: match[3].trim(),
      sheets: expandSheetRange(match[3].trim()),
      source: match[4].trim(),
    }));

  // 无表格时也可能是单条企业提示页（B8 场景）。
  const single = html.match(/企业\s*([A-Za-z0-9-]+)\s*档页\s*([A-Za-z0-9-]+)，册页\s*([A-Za-z0-9-/–]+)/);
  if (!rows.length && single) {
    rows.push({
      archiveNo: single[2].split('/')[0],
      subject: single[1],
      sheetRange: single[3],
      sheets: expandSheetRange(single[3]),
      source: '单条查询',
    });
  }

  const form = html.match(/<form action="\/archive\/pull\/([^"]+)" method="post">/);
  const pullOffice = form?.[1] ?? null;
  return { taskNo, status, rows, pullOffice, rawText: stripTags(html) };
}

/** 领件流水页：逐段解析 `机关 受理号 档页 状态`，扫描链接另列。 */
export function parseRequestsPage(html) {
  const items = [...html.matchAll(
    /<p>(old|new)\s+(W\d+)\s+([A-Za-z0-9-]+\/[A-Za-z0-9-]+)\s+(已受理|文件可取|明确未受理)(?:\s+<a href="([^"]+)">([^<]+)<\/a>)?<\/p>/g,
  )].map(match => ({
    office: match[1],
    acceptanceNo: match[2],
    folio: match[3],
    statusText: match[4],
    scanPath: match[5] ?? null,
    scanLabel: match[6] ?? null,
  }));
  return { items, rawText: stripTags(html) };
}

/**
 * 取档提交响应：
 *  - 受理页直接给受理号（如 W5）；
 *  - “页面连接已关闭”表示提交已发出但结论要去异步流水页确认（受理仍可能成立并扣份）。
 */
export function parsePullResponse(html) {
  const accepted = html.match(/已受理<\/h1><p>(W\d+)</);
  if (accepted) return { outcome: 'ACCEPTED', acceptanceNo: accepted[1] };
  if (html.includes('页面连接已关闭')) {
    return { outcome: 'CONNECTION_CLOSED', acceptanceNo: null };
  }
  if (html.includes('申请表中的企业或档页不可受理')) {
    return { outcome: 'FORM_REJECTED', acceptanceNo: null };
  }
  throw new PortalContractError('取档响应页结构异常', { excerpt: stripTags(html).slice(0, 80) });
}

/** 扫描页：签发要素、归属、适用区间、联章状态。 */
export function parseScanPage(html) {
  const text = stripTags(html);
  const header = html.match(/<h1>([^<]+)<\/h1>/)?.[1] ?? '';
  const issue = text.match(/签发号\s*([A-Za-z0-9-]+)\s*(原机关|承接机关)\s*档号\s*([A-Za-z0-9-]+)\s*册页\s*([A-Za-z0-9-/]+)/);
  const applicability = text.match(/签发\s*(\d+)\s*适用于\s*(\d+)\s*[–-]\s*(\d+)\s*归属\s*([A-Za-z0-9-]+)/);
  const sealPending = text.match(/联章待核\s*([^\s]+(?:第\d+页)?)/);
  const sealVerified = text.match(/联章号\s*([A-Za-z0-9-]+)\s*来自旧页\s*([A-Za-z0-9-/]+)，本页已验明/);
  const sealStandalone = text.match(/归属\s*([A-Za-z0-9-]+)\s*册页\s*([A-Za-z0-9-/]+)\s*联章号\s*([A-Za-z0-9-]+)(?:\s*适用于\s*([^<]+))?/);
  const replacement = text.match(/承接原机关档号\s*([A-Za-z0-9-/]+)，明确替代签发号\s*([A-Za-z0-9-]+)/);

  return {
    header,
    text,
    issue: issue ? {
      issueNo: issue[1], office: issue[2].trim(),
      archiveNo: issue[3], sheetRef: issue[4],
    } : null,
    applicability: applicability ? {
      issuedAt: Number(applicability[1]),
      appliesFrom: Number(applicability[2]),
      appliesUntil: Number(applicability[3]),
      subject: applicability[4],
    } : null,
    seal: sealPending
      ? { status: 'PENDING', counterSheet: sealPending[1] }
      : sealVerified
        ? { status: 'VERIFIED', sealNo: sealVerified[1], sourceSheet: sealVerified[2] }
        : sealStandalone
          ? {
              status: 'STANDALONE', subject: sealStandalone[1], sheetRef: sealStandalone[2],
              sealNo: sealStandalone[3],
              applicableTo: sealStandalone[4]?.split(/[、,]/).map(s => s.trim()).filter(Boolean) ?? [],
            }
          : null,
    replacement: replacement ? { sourceFolio: replacement[1], supersedes: replacement[2] } : null,
  };
}

/** 扫描包清单页：每个链接是一页，保留物理顺序（补发/更正页可能在封面之后）。 */
export function parsePackageManifest(html) {
  return [...html.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)]
    .map(match => ({ path: match[1], label: match[2].trim() }));
}

/** 从表单 HTML 提取服务端允许的 folio 白名单（form 校验值）。 */
export function parseAllowedFoliosFromForm(html) {
  // 来源服务的白名单在 data/sources.json 的 form.folio；门户页面本身只给输入框，
  // 因此白名单由客户端在提交前通过 HEAD 式校验探测或由配置下发，这里解析 data-folio 约定。
  const declared = html.match(/data-allowed-folio="([^"]+)"/);
  return declared ? declared[1].split(',').map(value => value.trim()) : null;
}
