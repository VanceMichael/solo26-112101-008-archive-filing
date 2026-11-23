/**
 * 可复核审计流水。
 * 索引请求与取档请求各有独立序列：
 *  - INDEX 流水证明“查过什么、命中哪些档号册页”，不能用来认定取件成功；
 *  - PULL  流水证明“门户受理/取件/收据”，受理号与正式收据号都挂在这里。
 */
export const AUDIT_KIND = Object.freeze({
  INDEX_SEARCH: 'INDEX_SEARCH',
  INDEX_SHARD: 'INDEX_SHARD',
  PULL_SUBMIT: 'PULL_SUBMIT',
  PULL_ACCEPTED: 'PULL_ACCEPTED',
  PULL_REJECTED: 'PULL_REJECTED',
  PULL_AVAILABLE: 'PULL_AVAILABLE',
  PULL_RECEIPT: 'PULL_RECEIPT',
  PULL_EXPIRED: 'PULL_EXPIRED',
  PULL_LATE_ACCEPTED: 'PULL_LATE_ACCEPTED',
  QUOTA: 'QUOTA',
  INSPECTION: 'INSPECTION',
  HANDOVER: 'HANDOVER',
  AUTHORIZATION: 'AUTHORIZATION',
});

class SerialSequence {
  constructor(prefix) {
    this.prefix = prefix;
    this.counter = 0;
  }

  next() {
    this.counter += 1;
    return `${this.prefix}-${this.counter.toString().padStart(4, '0')}`;
  }
}

export class AuditLog {
  constructor() {
    this.entries = [];
    this.indexSerial = new SerialSequence('IX');
    this.pullSerial = new SerialSequence('PL');
  }

  record(kind, payload = {}, { at } = {}) {
    const entry = {
      auditId: this.entries.length + 1,
      kind,
      at,
      serial: kind.startsWith('INDEX')
        ? this.indexSerial.next()
        : kind.startsWith('PULL') || kind === AUDIT_KIND.QUOTA
          ? this.pullSerial.next()
          : null,
      payload,
    };
    this.entries.push(entry);
    return entry;
  }

  byKind(kind) {
    return this.entries.filter(entry => entry.kind === kind);
  }

  /** 索引流水与取档流水分开复核。 */
  indexTrail() {
    return this.entries.filter(entry => entry.kind.startsWith('INDEX'));
  }

  pullTrail() {
    return this.entries.filter(entry =>
      entry.kind.startsWith('PULL') || entry.kind === AUDIT_KIND.QUOTA);
  }
}
