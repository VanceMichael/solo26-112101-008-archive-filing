/**
 * 签发 / 替代 / 交接沿革（lineage）。
 * 迁移后的对接规则：
 *  - 旧机关只能证明它以前签发过的页；
 *  - 新机关掌管接手之后有效的重打和更正；
 *  - 只有带“旧档出处 + 承接范围”的记录能接上原档，否则沿革断裂、不得宣称承接。
 * 原件是否有效（originalValidity）与它是否还代表当前声明（representsCurrent）是两个独立判断。
 */
export const RECORD_KIND = Object.freeze({
  ISSUE: 'ISSUE',                 // 原始签发
  REISSUE: 'REISSUE',             // 重打件
  CORRECTION: 'CORRECTION',       // 更正页
  TRANSFER: 'TRANSFER',           // 机关迁移交接
});

let recordSequence = 0;

export class LineageRecord {
  constructor({
    kind, issueNo, office, subject, folio, sheetRef, issuedAt,
    appliesFrom, appliesUntil, supersedes = null, sourceFolio = null,
    successionScope = null, transferAt = null, confirmed = true,
    confirmedAt = null, note = '',
  }) {
    this.recordId = `LR-${(++recordSequence).toString().padStart(4, '0')}`;
    this.kind = kind;
    this.issueNo = issueNo;           // 签发号，如 K1 / K5
    this.office = office;
    this.subject = subject;
    this.folio = folio;               // 档号/页号
    this.sheetRef = sheetRef;         // 扫描册页坐标
    this.issuedAt = issuedAt;
    this.appliesFrom = appliesFrom;   // 声明适用区间
    this.appliesUntil = appliesUntil;
    this.supersedes = supersedes;     // 明确替代的旧签发号
    this.sourceFolio = sourceFolio;   // 旧档出处（承接必填）
    this.successionScope = successionScope; // 承接范围（承接必填）
    this.transferAt = transferAt;
    this.confirmed = confirmed;       // 后件是否已确认取得
    this.confirmedAt = confirmedAt;
    this.note = note;
  }

  /** 该记录在时点 t 是否仍是有效声明（按适用区间）。 */
  validAt(t) {
    return t >= this.appliesFrom && t <= this.appliesUntil;
  }
}

export class LineageGraph {
  constructor() {
    this.records = [];
  }

  add(record) {
    if ([RECORD_KIND.REISSUE, RECORD_KIND.CORRECTION].includes(record.kind)) {
      if (!record.sourceFolio || !record.successionScope) {
        throw new Error('重打/更正记录必须带旧档出处与承接范围，否则不能接上原档');
      }
    }
    this.records.push(record);
    return record;
  }

  /** 找全与某档页相互关联的签发、替代及交接记录。 */
  relatedTo(folio) {
    const direct = this.records.filter(record =>
      record.folio === folio || record.sourceFolio === folio);
    const issueNos = new Set(direct.map(record => record.issueNo)
      .concat(direct.map(record => record.supersedes).filter(Boolean)));
    return this.records.filter(record =>
      record.folio === folio
      || record.sourceFolio === folio
      || issueNos.has(record.issueNo)
      || issueNos.has(record.supersedes))
      .sort((a, b) => a.issuedAt - b.issuedAt);
  }

  /** 旧档是否已被带出处与承接范围的后件接上。 */
  isLinkedToOriginal(sourceFolio) {
    return this.records.some(record =>
      [RECORD_KIND.REISSUE, RECORD_KIND.CORRECTION].includes(record.kind)
      && record.sourceFolio === sourceFolio
      && Boolean(record.successionScope));
  }

  /**
   * 查旧时点：要能见到当时材料——返回该时点有效的原始签发（含已被替代但曾经有效的页）。
   */
  materialsAsOf({ subject, at }) {
    return this.records
      .filter(record => record.subject === subject
        && record.kind === RECORD_KIND.ISSUE
        && record.appliesFrom <= at
        && record.issuedAt <= at)
      .map(record => ({
        record,
        originalValidity: record.validAt(at),
        representsCurrent: this._representsCurrent(record, at),
        supersededBy: this._superseder(record),
      }));
  }

  /**
   * 查当前材料：呈现已确认的后件；后件未确认取得时，说明尚未取得哪页。
   */
  currentMaterials({ subject, at }) {
    const issues = this.records.filter(record =>
      record.subject === subject && record.kind === RECORD_KIND.ISSUE);
    return issues.map(issue => {
      const superseder = this._superseder(issue);
      if (!superseder) {
        return {
          source: issue,
          presentation: issue.validAt(at) ? 'ORIGINAL_CURRENT' : 'ORIGINAL_LAPSED',
          originalValidity: issue.validAt(at),
          representsCurrent: issue.validAt(at),
        };
      }
      if (!superseder.confirmed) {
        return {
          source: issue,
          presentation: 'SUCCESSOR_PENDING',
          missingFolio: superseder.folio,
          note: `后件 ${superseder.issueNo} 尚未确认取得，当前材料暂缺该页`,
        };
      }
      return {
        source: issue,
        presentation: 'SUCCESSOR_CURRENT',
        successor: superseder,
        originalValidity: issue.validAt(at),
        representsCurrent: superseder.validAt(at),
      };
    });
  }

  _superseder(issue) {
    return this.records.find(record =>
      record.supersedes === issue.issueNo
      && [RECORD_KIND.REISSUE, RECORD_KIND.CORRECTION].includes(record.kind)) ?? null;
  }

  _representsCurrent(issue, at) {
    const superseder = this._superseder(issue);
    if (!superseder) return issue.validAt(at);
    // 后件尚未到签发时点或未确认取得：当前声明仍由原件表达（即使原件适用期已过，
    // 系统也如实标注，而不是把未到手的后件当成当前材料）。
    if (!superseder.confirmed || superseder.issuedAt > at) {
      return issue.validAt(at);
    }
    return superseder.validAt(at);
  }
}
