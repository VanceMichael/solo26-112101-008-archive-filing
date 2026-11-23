import { ForeignPageError } from './errors.js';

/**
 * 扫描包与纸档核验。
 * 纸档特征：
 *  - 补发/更正页可能排在封面之后；
 *  - 跨页章（联章）可能待核，或缺面提示；
 *  - 页头归属企业短码以扫描页自身标识为准，扫描包外层不能替代；
 *  - 某页联章号可被两笔已许可档卷共用（同企业、同册来源）。
 */
export const PAGE_KIND = Object.freeze({
  COVER: 'COVER',         // 封面
  ORIGINAL: 'ORIGINAL',   // 原册页
  REISSUE: 'REISSUE',     // 补发页（可能在封面之后）
  CORRECTION: 'CORRECTION', // 更正页
  SEAL_SHEET: 'SEAL_SHEET', // 单页联章
});

export const PAGE_VERDICT = Object.freeze({
  OK: 'OK',                     // 可发窗口比对
  PENDING_CROSS_SEAL: 'PENDING_CROSS_SEAL', // 联章待核：柜台给查补联章页码
  FOREIGN_BLOCKED: 'FOREIGN_BLOCKED',       // 混入别家企业页：扣留
  MISSING: 'MISSING',           // 缺面提示
  ARCHIVIST_HOLD: 'ARCHIVIST_HOLD', // 唯一联章依据被扣留：先交档案员核实
});

let pageSequence = 0;

export class ScannedPage {
  constructor({
    kind = PAGE_KIND.ORIGINAL, subject, folio, sheetRef, sealNo = null,
    sealVerified = false, sealSourceSheet = null, missing = false,
    applicableFolios = [], note = '',
  }) {
    this.pageId = `SP-${(++pageSequence).toString().padStart(4, '0')}`;
    this.kind = kind;
    this.subject = subject;             // 页头归属短码（权威标识）
    this.folio = folio;
    this.sheetRef = sheetRef;
    this.sealNo = sealNo;               // 联章号，如 C1
    this.sealVerified = sealVerified;   // 联章是否已验明
    this.sealSourceSheet = sealSourceSheet; // 查补联章的页码（柜台给出）
    this.missing = missing;             // 缺面提示
    this.applicableFolios = applicableFolios; // 联章适用的档卷（可两笔共用）
    this.note = note;
  }
}

export class ScanPackage {
  constructor({ packageId, office, requestId, pages = [], note = '' }) {
    this.packageId = packageId;
    this.office = office;
    this.requestId = requestId;
    this.pages = pages;
    this.note = note;
  }

  /** 补发/更正页可能在封面之后：按物理顺序保留，同时给出逻辑排序。 */
  orderedPages() {
    const cover = this.pages.filter(page => page.kind === PAGE_KIND.COVER);
    const rest = this.pages.filter(page => page.kind !== PAGE_KIND.COVER);
    return [...cover, ...rest];
  }
}

/**
 * 联章登记：联章号 -> 已验明的联章页。
 * 已许可档卷之间可共用同一联章依据；别家企业的联章号不得拿来补本企业档案。
 */
export class SealRegistry {
  constructor() {
    this.seals = new Map();
  }

  register(page) {
    if (!page.sealNo) return;
    if (!this.seals.has(page.sealNo)) this.seals.set(page.sealNo, []);
    this.seals.get(page.sealNo).push(page);
  }

  /**
   * 查联章依据：必须同企业、来源页适用该档卷。
   * 已知联章号时按号匹配；待核页尚未见号时，可按适用档卷反查已验明的联章页。
   * 返回 null 表示尚无可用联章，需要单页查补。
   */
  findBasis({ sealNo, subject, folio }) {
    const candidates = this.seals.get(sealNo) ?? [];
    const byNo = candidates.find(page => page.subject === subject
      && page.sealVerified
      && (page.applicableFolios.includes(folio) || page.folio === folio));
    if (byNo) return byNo;
    if (sealNo) return null;
    // 待核页只知道柜台指页，按档卷反查同企业已验明联章。
    return [...this.seals.values()].flat().find(page => page.subject === subject
      && page.sealVerified
      && page.applicableFolios.includes(folio)) ?? null;
  }
}

/**
 * 扫描核验服务：逐页给出处置结论。
 */
export class InspectionService {
  constructor(sealRegistry = new SealRegistry()) {
    this.sealRegistry = sealRegistry;
    this.holds = []; // 档案员核实队列
  }

  inspect({ pkg, expectedSubject }) {
    const results = [];
    for (const page of pkg.orderedPages()) {
      if (page.missing) {
        results.push(this._verdict(page, PAGE_VERDICT.MISSING, '缺面提示：该页尚未扫描到件'));
        continue;
      }
      // 归属以扫描页页头为准；混入别家企业一页不能发给窗口比对。
      if (page.subject !== expectedSubject) {
        const result = this._verdict(page, PAGE_VERDICT.FOREIGN_BLOCKED,
          `扫描包混入归属 ${page.subject} 的页，与委托企业 ${expectedSubject} 不符，已扣留`);
        results.push(result);
        this._maybeArchivistHold(page, results);
        continue;
      }
      // 联章待核：带未验明联章号，或柜台已给查补联章页码但联章尚未验明；
      // 已验明的同企业联章页可作为依据，跨企业联章号一律不认。
      const sealPending = (page.sealNo && !page.sealVerified)
        || (!page.sealVerified && page.sealSourceSheet);
      if (sealPending) {
        const basis = this.sealRegistry.findBasis({
          sealNo: page.sealNo, subject: expectedSubject, folio: page.folio,
        });
        if (basis) {
          results.push(this._verdict(page, PAGE_VERDICT.OK,
            `联章号 ${basis.sealNo} 已由 ${basis.sheetRef} 验明（档卷共用）`, { basis }));
        } else {
          results.push(this._verdict(page, PAGE_VERDICT.PENDING_CROSS_SEAL,
            `联章待核：柜台查补联章页 ${page.sealSourceSheet ?? '(待指页)'}`,
            { counterSheet: page.sealSourceSheet }));
        }
        continue;
      }
      results.push(this._verdict(page, PAGE_VERDICT.OK, '核验通过'));
    }
    return {
      packageId: pkg.packageId,
      releasable: results.filter(r => r.verdict === PAGE_VERDICT.OK),
      blocked: results.filter(r => r.verdict !== PAGE_VERDICT.OK),
      allResults: results,
    };
  }

  /**
   * 被扣留的别家页恰是获批页唯一联章依据时，先交档案员核实，禁止直接采用。
   * 命中条件（满足其一）：
   *  - 联章号一致；
   *  - 柜台指页坐标与扣留页册页坐标一致；
   *  - 柜台只给描述性指页（如“原册第3页”），而扣留页是同包内唯一带联章号的页。
   */
  _maybeArchivistHold(foreignPage, results) {
    const pending = results.find(r => r.verdict === PAGE_VERDICT.PENDING_CROSS_SEAL);
    if (!pending || !foreignPage.sealNo) return;
    const exactCounterSheet = foreignPage.sheetRef !== null
      && foreignPage.sheetRef === pending.page.sealSourceSheet;
    const descriptivePointer = pending.page.sealSourceSheet !== null
      && !/^[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/.test(pending.page.sealSourceSheet);
    if (foreignPage.sealNo === pending.page.sealNo || exactCounterSheet
      || (descriptivePointer && this._onlySealInPackage(foreignPage, results))) {
      const hold = {
        holdId: `AH-${this.holds.length + 1}`,
        reason: '唯一联章依据页归属别家企业，需档案员核实后方可决定查补路径',
        foreignPage: foreignPage.pageId,
        blockedFolio: pending.page.folio,
        sealNo: foreignPage.sealNo,
        counterSheet: foreignPage.sheetRef ?? pending.page.sealSourceSheet,
      };
      this.holds.push(hold);
      pending.verdict = PAGE_VERDICT.ARCHIVIST_HOLD;
      pending.note = hold.reason;
      pending.holdId = hold.holdId;
    }
  }

  _onlySealInPackage(foreignPage, results) {
    const sealPages = results.filter(r => r.page.sealNo);
    return sealPages.length === 1 && sealPages[0].page.pageId === foreignPage.pageId;
  }

  /** 试图把扣留页发给窗口时直接拒绝（界面层的硬保护）。 */
  assertReleasable(page, expectedSubject) {
    if (page.subject !== expectedSubject) {
      throw new ForeignPageError('别家企业扫描页不得发给窗口比对', {
        pageId: page.pageId, expected: expectedSubject, actual: page.subject,
      });
    }
  }

  _verdict(page, verdict, note, extra = {}) {
    return { pageId: page.pageId, page, verdict, note, ...extra };
  }
}
