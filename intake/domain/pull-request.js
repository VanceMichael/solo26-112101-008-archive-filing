import { IllegalStateError, PendingPullError } from './errors.js';

/**
 * 取档请求状态机。
 * 门户确认受理即扣用一份调阅份数，即使窗口随后关闭（连接断开不影响已成立的受理）。
 * 索引流水与取档流水各自独立、各自可复核。
 */
export const PULL_STATE = Object.freeze({
  SUBMITTED: 'SUBMITTED',       // 已提交，门户尚未给受理结论（窗口可能已关闭）
  ACCEPTED: 'ACCEPTED',         // 已受理：份数已扣，门户仍可能回件
  REJECTED: 'REJECTED',         // 明确未受理：预占份数释放
  AVAILABLE: 'AVAILABLE',       // 文件可取
  EXPIRED: 'EXPIRED',           // 超过门户回件窗口仍无受理结论
  LATE_ACCEPTED: 'LATE_ACCEPTED', // 窗口关闭后的迟到受理：份数照扣，可能透支，交裁决
  RETRIEVED: 'RETRIEVED',       // 已异步取档并拿到正式收据/扫描包
  QUARANTINED: 'QUARANTINED',   // 扫描包混入别家页，扣留待档案员核实
  HANDED_OVER: 'HANDED_OVER',   // 已交还企业
});

/** 终态之外，同档再请求一律拦截（门户仍可能回件，不能再耗一份）。 */
const TERMINAL = new Set([
  PULL_STATE.REJECTED,
  PULL_STATE.LATE_ACCEPTED,
  PULL_STATE.HANDED_OVER,
]);

const TRANSITIONS = Object.freeze({
  [PULL_STATE.SUBMITTED]: [PULL_STATE.ACCEPTED, PULL_STATE.REJECTED, PULL_STATE.EXPIRED],
  [PULL_STATE.ACCEPTED]: [
    PULL_STATE.AVAILABLE,
    PULL_STATE.REJECTED,
    PULL_STATE.EXPIRED,
    PULL_STATE.LATE_ACCEPTED,
  ],
  [PULL_STATE.EXPIRED]: [PULL_STATE.LATE_ACCEPTED],
  [PULL_STATE.AVAILABLE]: [PULL_STATE.RETRIEVED, PULL_STATE.QUARANTINED],
  [PULL_STATE.RETRIEVED]: [PULL_STATE.HANDED_OVER, PULL_STATE.QUARANTINED],
  [PULL_STATE.QUARANTINED]: [PULL_STATE.RETRIEVED, PULL_STATE.HANDED_OVER],
  [PULL_STATE.REJECTED]: [],
  [PULL_STATE.LATE_ACCEPTED]: [PULL_STATE.AVAILABLE],
  [PULL_STATE.HANDED_OVER]: [],
});

let sequence = 0;

export class PullRequest {
  constructor({ mandateId, subject, office, folios, at, indexSerial, pullSerial }) {
    this.requestId = `PR-${(++sequence).toString().padStart(4, '0')}`;
    this.mandateId = mandateId;
    this.subject = subject;
    this.office = office;
    // 一份取档包允许合并多个档号；单页调取时 folios 只有一项。
    this.folios = [...folios];
    this.indexSerial = indexSerial; // 所依据的索引流水（线索，不是取件凭证）
    this.pullSerial = pullSerial;   // 取档请求流水（提交即可复核）
    this.acceptanceNo = null;       // 门户受理号，如 W5（与新机关同号按机关区分）
    this.receiptNo = null;          // 异步取档页请求后得到的正式收据号
    this.state = PULL_STATE.SUBMITTED;
    this.history = [{ at, state: PULL_STATE.SUBMITTED, note: '取档请求已提交' }];
    this.quotaEntryId = null;       // 关联的调阅份数台账明细
    this.reRetrievableAt = null;    // 可重领时点（终态后才允许同档再申请）
  }

  transition(next, { at, note = '', acceptanceNo = null, receiptNo = null } = {}) {
    const allowed = TRANSITIONS[this.state];
    if (!allowed.includes(next)) {
      throw new IllegalStateError(`取档请求不能从 ${this.state} 转为 ${next}`, {
        requestId: this.requestId, current: this.state, requested: next,
      });
    }
    this.state = next;
    if (acceptanceNo) this.acceptanceNo = acceptanceNo;
    if (receiptNo) this.receiptNo = receiptNo;
    if (TERMINAL.has(next) && this.reRetrievableAt === null) {
      this.reRetrievableAt = at;
    }
    this.history.push({ at, state: next, note, acceptanceNo, receiptNo });
  }

  get isTerminal() {
    return TERMINAL.has(this.state);
  }

  /** 同档（企业+机关+档页有交集）是否仍在门户处理中。 */
  blocksSameFolio(other) {
    if (this.subject !== other.subject || this.office !== other.office) return false;
    if (this.isTerminal) return false;
    return this.folios.some(folio => other.folios.includes(folio));
  }

  /** 已确认受理（含迟到受理）——份数不可退回。 */
  get quotaCharged() {
    return [PULL_STATE.ACCEPTED, PULL_STATE.AVAILABLE, PULL_STATE.RETRIEVED,
      PULL_STATE.QUARANTINED, PULL_STATE.HANDED_OVER, PULL_STATE.LATE_ACCEPTED]
      .includes(this.state);
  }
}

/**
 * 取档请求登记册：保证“门户仍可能回件时同档不耗第二份”。
 */
export class PullLedger {
  constructor() {
    this.requests = [];
  }

  add(request) {
    const blocker = this.requests.find(existing => existing.blocksSameFolio(request));
    if (blocker) {
      throw new PendingPullError('同档请求门户仍可能回件，禁止重复消耗调阅份数', {
        folios: request.folios, office: request.office,
        blocker: { requestId: blocker.requestId, state: blocker.state, reRetrievableAt: blocker.reRetrievableAt },
      });
    }
    this.requests.push(request);
    return request;
  }

  byAcceptance(office, acceptanceNo) {
    return this.requests.find(
      request => request.office === office && request.acceptanceNo === acceptanceNo,
    ) ?? null;
  }

  /** 经办人员查各档请求的可重领时点与当前状态。 */
  statusForFolio(subject, office, folio) {
    return this.requests
      .filter(request => request.subject === subject
        && request.office === office
        && request.folios.includes(folio))
      .map(request => ({
        requestId: request.requestId,
        folios: request.folios,
        state: request.state,
        acceptanceNo: request.acceptanceNo,
        receiptNo: request.receiptNo,
        reRetrievableAt: request.reRetrievableAt,
      }));
  }

  pendingFor(subject, office, folio) {
    const probe = { subject, office, folios: [folio] };
    return this.requests.find(request => request.blocksSameFolio(probe)) ?? null;
  }
}
