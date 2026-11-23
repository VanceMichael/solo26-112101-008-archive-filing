import { QuotaError } from './errors.js';

/**
 * 调阅份数台账。
 * 两张额度：officeQuotas 按机关独立结算，quota 是全委托总限额（跨机关共享）。
 * 提交即预占（HOLD），门户确认受理转为 CONSUMED（受理即扣，窗口关闭也不退）；
 * 明确未受理 / 窗口关闭且无迟到受理时释放 HOLD。
 * 迟到受理在释放之后到达：额度照扣，余额不足记 OVERDRAWN 冲突，交人工裁决，
 * 系统不会把同一份数再许给第二次申请。
 */
export const QUOTA_ENTRY = Object.freeze({
  HOLD: 'HOLD',           // 已预占，等待门户受理结论
  CONSUMED: 'CONSUMED',   // 门户已受理，份数扣定
  RELEASED: 'RELEASED',   // 未受理/窗口关闭，预占释放
  OVERDRAWN: 'OVERDRAWN', // 迟到受理造成的透支，需裁决
});

let entrySequence = 0;

export class QuotaLedger {
  /**
   * @param limits 批单限额 { quota: 总限额, officeQuotas: { old: n, new: n } }
   */
  constructor({ mandateId, subject, limits }) {
    this.mandateId = mandateId;
    this.subject = subject;
    this.limits = {
      total: limits.quota,
      perOffice: { ...limits.officeQuotas },
    };
    this.entries = [];
  }

  reserve({ office, requestId, at }) {
    const blocked = this._conflicts();
    if (blocked.length) {
      throw new QuotaError('存在迟到受理透支待裁决，暂停新的份数预占', {
        mandateId: this.mandateId, conflicts: blocked,
      });
    }
    const availableOffice = this._available(office);
    const availableTotal = this._availableTotal();
    if (availableOffice <= 0 || availableTotal <= 0) {
      throw new QuotaError('调阅份数不足：机关或全委托总限额已无可用份数', {
        mandateId: this.mandateId, office,
        availableOffice, availableTotal,
        officeLimit: this.limits.perOffice[office] ?? 0,
        totalLimit: this.limits.total,
      });
    }
    const entry = {
      entryId: `QE-${(++entrySequence).toString().padStart(4, '0')}`,
      mandateId: this.mandateId,
      office,
      requestId,
      state: QUOTA_ENTRY.HOLD,
      at,
      events: [{ at, state: QUOTA_ENTRY.HOLD }],
    };
    this.entries.push(entry);
    return entry.entryId;
  }

  /** 门户确认受理（含窗口关闭后的迟到受理）。 */
  confirmAccepted({ requestId, at, late = false }) {
    const entry = this._byRequest(requestId);
    if (entry.state === QUOTA_ENTRY.CONSUMED) return entry;
    if (entry.state === QUOTA_ENTRY.HOLD) {
      entry.state = QUOTA_ENTRY.CONSUMED;
    } else if (entry.state === QUOTA_ENTRY.RELEASED) {
      // 迟到受理：份数必须扣回。余额够就补扣，不够记透支并冻结后续预占。
      const enough = this._available(entry.office) > 0 && this._availableTotal() > 0;
      entry.state = enough ? QUOTA_ENTRY.CONSUMED : QUOTA_ENTRY.OVERDRAWN;
      entry.late = true;
    } else {
      throw new QuotaError('该份数明细已透支裁决，不能重复受理', { requestId });
    }
    entry.events.push({ at, state: entry.state, late });
    return entry;
  }

  /** 明确未受理，或窗口关闭且确认不会再有受理。 */
  release({ requestId, at, reason }) {
    const entry = this._byRequest(requestId);
    if (entry.state === QUOTA_ENTRY.HOLD) {
      entry.state = QUOTA_ENTRY.RELEASED;
      entry.events.push({ at, state: entry.state, reason });
    }
    return entry;
  }

  /** 经办人员查调阅余额与归属。 */
  balance() {
    const perOffice = Object.fromEntries(
      Object.entries(this.limits.perOffice).map(([office, limit]) => [office, {
        limit,
        held: this._count(office, QUOTA_ENTRY.HOLD),
        consumed: this._count(office, QUOTA_ENTRY.CONSUMED),
        overdrawn: this._count(office, QUOTA_ENTRY.OVERDRAWN),
        available: this._available(office),
      }]),
    );
    return {
      mandateId: this.mandateId,
      subject: this.subject,
      total: {
        limit: this.limits.total,
        held: this.entries.filter(e => e.state === QUOTA_ENTRY.HOLD).length,
        consumed: this.entries.filter(e => e.state === QUOTA_ENTRY.CONSUMED).length,
        overdrawn: this.entries.filter(e => e.state === QUOTA_ENTRY.OVERDRAWN).length,
        available: this._availableTotal(),
      },
      perOffice,
    };
  }

  _conflicts() {
    return this.entries.filter(entry => entry.state === QUOTA_ENTRY.OVERDRAWN);
  }

  _available(office) {
    const limit = this.limits.perOffice[office] ?? 0;
    const used = this.entries
      .filter(entry => entry.office === office
        && [QUOTA_ENTRY.HOLD, QUOTA_ENTRY.CONSUMED, QUOTA_ENTRY.OVERDRAWN].includes(entry.state))
      .length;
    return limit - used;
  }

  _availableTotal() {
    const used = this.entries
      .filter(entry => [QUOTA_ENTRY.HOLD, QUOTA_ENTRY.CONSUMED, QUOTA_ENTRY.OVERDRAWN].includes(entry.state))
      .length;
    return this.limits.total - used;
  }

  _count(office, state) {
    return this.entries.filter(entry => entry.office === office && entry.state === state).length;
  }

  _byRequest(requestId) {
    const entry = this.entries.find(candidate => candidate.requestId === requestId);
    if (!entry) throw new QuotaError(`找不到取档请求 ${requestId} 的份数明细`, { requestId });
    return entry;
  }
}

/**
 * 多委托台账集合：不同企业的批单互不影响——
 * 一家冻结/透支时，不受这项余额影响的另一企业可以继续查找。
 */
export class QuotaLedgers {
  constructor() {
    this.ledgers = new Map();
  }

  forMandate(mandate) {
    const revision = mandate.revisions[mandate.revisions.length - 1];
    if (!this.ledgers.has(mandate.id)) {
      this.ledgers.set(mandate.id, new QuotaLedger({
        mandateId: mandate.id,
        subject: mandate.subject,
        limits: { quota: revision.quota, officeQuotas: revision.officeQuotas },
      }));
    }
    return this.ledgers.get(mandate.id);
  }

  allBalances() {
    return [...this.ledgers.values()].map(ledger => ledger.balance());
  }
}
