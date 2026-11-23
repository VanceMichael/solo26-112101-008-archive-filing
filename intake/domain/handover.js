import { AuthorizationError, DomainError } from './errors.js';

/**
 * 交还企业的交接凭证。
 * 每次交接必须说明材料能证明的所属期与签发机关，并保留“资料已迁出原机关”的证据。
 * 授权撤回后：已完成的交接留凭据，但不再提供原件下载；未交接页不得出具。
 * 窗口不代办申报或信用修复，也不凭任何回执宣布企业获得某信用等级。
 */
export const HANDOVER_MODE = Object.freeze({
  HISTORICAL: 'HISTORICAL', // 查旧时点：见当时材料
  CURRENT: 'CURRENT',       // 查当前：已确认后件或说明缺页
});

const RATING_CLAIM_PATTERN = /信用等级|评级|信用评定|等级[为为：:]/;

let handoverSequence = 0;

export class HandoverPacket {
  constructor({ mandateId, subject, mode, requestedAt, items, migrationEvidence, note }) {
    this.handoverId = `HO-${(++handoverSequence).toString().padStart(4, '0')}`;
    this.mandateId = mandateId;
    this.subject = subject;
    this.mode = mode;
    this.requestedAt = requestedAt;
    this.createdAt = requestedAt;
    // items: { folio, office, issueNo, appliesFrom, appliesUntil, kind,
    //          sourceFolio?, missing? }
    this.items = items;
    this.migrationEvidence = migrationEvidence; // 交接记录（迁出证据）
    this.note = this._assertNoRatingClaim(note);
    this.status = 'HANDED';
  }

  /** 任何交接文案不得出现信用等级结论。 */
  _assertNoRatingClaim(text = '') {
    if (RATING_CLAIM_PATTERN.test(text)) {
      throw new DomainError('RATING_CLAIM_FORBIDDEN',
        '不得凭任何回执宣布企业获得某信用等级；窗口不代办申报或信用修复', { text });
    }
    return text;
  }

  /** 授权撤回后界面是否仍可下载该交接项下原件（仅历史凭据可留存，不提供新原件）。 */
  downloadAllowed(folio, { mandate, at }) {
    if (!mandate.isRevoked || at < mandate.revokedAt) return { allowed: true };
    const item = this.items.find(entry => entry.folio === folio);
    if (!item) return { allowed: false, reason: '该页不在已交接凭据内' };
    return {
      allowed: false,
      evidenceRetained: true,
      reason: '授权已撤回：交接凭据留存备查，界面不再提供原件下载',
    };
  }
}

export class HandoverLedger {
  constructor() {
    this.packets = [];
  }

  add(packet) {
    this.packets.push(packet);
    return packet;
  }

  /** 某批单某页是否已完成交接（撤回后判断历史凭据用）。 */
  wasHandedOver(mandateId, folio) {
    return this.packets.some(packet =>
      packet.mandateId === mandateId
      && packet.items.some(item => item.folio === folio));
  }

  forSubject(subject) {
    return this.packets.filter(packet => packet.subject === subject);
  }

  /**
   * 组装交接项：
   *  - HISTORICAL：当时材料，标注原件有效性与是否仍代表当前声明（两回事分开写）；
   *  - CURRENT：已确认后件；后件未取得时明确缺哪页。
   */
  static buildItems({ mode, materials, at }) {
    if (mode === HANDOVER_MODE.HISTORICAL) {
      return materials.map(({ record, originalValidity, representsCurrent, supersededBy }) => ({
        folio: record.folio,
        office: record.office,
        issueNo: record.issueNo,
        kind: record.kind,
        appliesFrom: record.appliesFrom,
        appliesUntil: record.appliesUntil,
        sheetRef: record.sheetRef,
        originalValidity,                 // 原件在该时点是否有效
        representsCurrent,                // 是否仍代表当前声明（独立判断）
        supersededBy: supersededBy?.issueNo ?? null,
      }));
    }
    return materials.map(entry => {
      if (entry.presentation === 'SUCCESSOR_PENDING') {
        return {
          folio: entry.source.folio,
          office: entry.source.office,
          issueNo: entry.source.issueNo,
          appliesFrom: entry.source.appliesFrom,
          appliesUntil: entry.source.appliesUntil,
          missing: true,
          missingFolio: entry.missingFolio,
          note: entry.note,
        };
      }
      const record = entry.successor ?? entry.source;
      return {
        folio: record.folio,
        office: record.office,
        issueNo: record.issueNo,
        kind: record.kind,
        appliesFrom: record.appliesFrom,
        appliesUntil: record.appliesUntil,
        sheetRef: record.sheetRef,
        sourceFolio: record.sourceFolio ?? null,
        successionScope: record.successionScope ?? null,
        originalValidity: entry.originalValidity,
        representsCurrent: entry.representsCurrent,
      };
    });
  }

  /** 交接前置校验：撤回后未交接页不得出具。 */
  assertCanIssue({ mandate, folios, at }) {
    if (!mandate.isRevoked || at < mandate.revokedAt) return;
    for (const folio of folios) {
      if (!this.wasHandedOver(mandate.id, folio)) {
        throw new AuthorizationError(
          `授权已于时点 ${mandate.revokedAt} 撤回，未交接页 ${folio} 不得向企业出具`,
          { mandateId: mandate.id, folio, revokedAt: mandate.revokedAt },
        );
      }
    }
  }
}
