import { AuthorizationError, FolioNotSeparableError } from './errors.js';
import { formatFolio, parseFolio } from './folio.js';

/**
 * 授权批单（委托）。同一 id 可出现多个修订：
 *  - 修订以 from/until 给出自身声明的有效区间；revokedAt 是批单级撤回时点（撤回即全单停效）。
 *  - 修订表达范围收窄或撤回增量，但不抹掉基础批单对其他机关/档页的授权：
 *    某档页在时点 t 可领，当且仅当“任一覆盖 t 的有效修订”包含它；
 *    rev2 把授权收窄到原机关 OD-5/2，不影响 rev1 仍覆盖的承接机关 ND-9/1 与 OD-5/3。
 *  - 全部失效（撤回或区间不覆盖）时该时点无授权。
 *  - 旧版本不删除，作为授权沿革保留，已完成交接的凭据不受后来撤回影响。
 */
export class Mandate {
  constructor(records) {
    if (!records?.length) throw new TypeError('授权批单不能为空');
    const baseId = records[0].id;
    if (records.some(record => record.id !== baseId)) {
      throw new TypeError('同一委托对象只能聚合相同批单编号的修订');
    }
    this.id = baseId;
    this.subject = records[0].subject;
    this.revisions = records
      .map(record => new MandateRevision(record))
      .sort((a, b) => a.revision - b.revision);
  }

  /** 时点 t 仍有效的全部修订；撤回是批单级动作，revokedAt 之后一律停效。 */
  activeRevisionsAt(t) {
    if (this.revokedAt !== null && t >= this.revokedAt) return [];
    return this.revisions.filter(revision => revision.covers(t));
  }

  /** 时点 t 的代表性修订（取最低修订号，用于展示与限额继承）；无则 null。 */
  revisionAt(t) {
    return this.activeRevisionsAt(t)[0] ?? null;
  }

  /** 撤回时点（取最早的 revokedAt）；未撤回返回 null。 */
  get revokedAt() {
    const markers = this.revisions
      .map(revision => revision.revokedAt)
      .filter(value => value !== undefined && value !== null);
    return markers.length ? Math.min(...markers) : null;
  }

  get isRevoked() {
    return this.revokedAt !== null;
  }

  /**
   * 在时点 t 校验企业对某机关档页的领取资格。
   * 规则：授权必须在有效期内、批单未撤回，且任一有效修订覆盖该机关的该档页。
   * 返回代表性有效修订（最低修订号），供限额与范围展示使用。
   */
  authorize({ subject, office, folio, at }) {
    if (subject !== this.subject) {
      throw new AuthorizationError('授权批单属于其他企业，不能用于本次领取', {
        mandateId: this.id, expected: this.subject, actual: subject,
      });
    }
    const active = this.activeRevisionsAt(at);
    if (!active.length) {
      throw new AuthorizationError(
        this.isRevoked && at >= this.revokedAt
          ? `授权批单 ${this.id} 已于时点 ${this.revokedAt} 撤回，不能再领取或出具未交接页`
          : `时点 ${at} 不在授权批单 ${this.id} 的有效区间内`,
        { mandateId: this.id, at, revokedAt: this.revokedAt },
      );
    }
    const covering = active.find(revision => revision.allows(office, folio));
    if (!covering) {
      throw new AuthorizationError('授权不覆盖该机关的此档页', {
        mandateId: this.id, activeRevisions: active.map(r => r.revision),
        office, folio, scope: active.map(r => r.offices[office] ?? []),
      });
    }
    return active[0];
  }
}

export class MandateRevision {
  constructor(record) {
    this.id = record.id;
    this.revision = record.revision ?? 1;
    this.subject = record.subject;
    this.from = record.from;
    this.until = record.until;
    this.revokedAt = record.revokedAt ?? null;
    this.offices = Object.fromEntries(
      Object.entries(record.offices ?? {}).map(([office, folios]) => [office, [...folios]]),
    );
    this.quota = record.quota;
    this.officeQuotas = { ...(record.officeQuotas ?? {}) };
    this.transfer = record.transfer ? { ...record.transfer } : null;
  }

  covers(t) {
    if (this.revokedAt !== null && t >= this.revokedAt) return false;
    return t >= this.from && t <= this.until;
  }

  allows(office, folio) {
    return Boolean(this.offices[office]?.includes(folio));
  }
}

/**
 * 委托册：登记全部批单并按企业/批单检索。
 * 一个企业可有多张批单；集团代办的多家企业各自独立结算、互不借用份数。
 */
export class MandateRegistry {
  constructor(mandates = []) {
    this.mandates = new Map();
    for (const mandate of mandates) this.register(mandate);
  }

  static fromRecords(records) {
    const grouped = new Map();
    for (const record of records) {
      if (!grouped.has(record.id)) grouped.set(record.id, []);
      grouped.get(record.id).push(record);
    }
    return new MandateRegistry([...grouped.values()].map(group => new Mandate(group)));
  }

  register(mandate) {
    this.mandates.set(mandate.id, mandate);
  }

  get(id) {
    const mandate = this.mandates.get(id);
    if (!mandate) throw new AuthorizationError(`找不到授权批单 ${id}`, { mandateId: id });
    return mandate;
  }

  /** 企业在时点 t 可用的批单（未失效）。 */
  forSubject(subject, at) {
    return [...this.mandates.values()]
      .filter(mandate => mandate.subject === subject && mandate.revisionAt(at) !== null);
  }

  /**
   * 授权 + 门户可单独调取双重校验。
   * 授权只覆盖部分册页时，只能领取门户明确允许单独调取的页；
   * separableFolios 来自门户表单（服务端表单校验是同一约束的最终裁决）。
   */
  authorizeSeparable({ mandateId, subject, office, folio, at, separableFolios }) {
    const mandate = this.get(mandateId);
    const revision = mandate.authorize({ subject, office, folio, at });
    const allowed = separableFolios ?? revision.offices[office] ?? [];
    if (!allowed.includes(folio)) {
      throw new FolioNotSeparableError('该页未在门户开放单独调取，只能随授权的整包领取', {
        mandateId, office, folio, separableFolios: allowed,
      });
    }
    return { mandate, revision };
  }

  /** 授权撤回后，界面是否还允许下载某档页原件（未交接页一律停止）。 */
  downloadPermitted({ mandateId, folio, handoverLedger, at }) {
    const mandate = this.get(mandateId);
    if (!mandate.isRevoked || at < mandate.revokedAt) return { permitted: true };
    const handed = handoverLedger?.wasHandedOver(mandateId, folio) ?? false;
    if (!handed) {
      return {
        permitted: false,
        reason: '授权已撤回，未交接页不得继续下载或向企业出具',
        revokedAt: mandate.revokedAt,
      };
    }
    return {
      permitted: false,
      evidenceRetained: true,
      reason: '授权已撤回：交接凭据留存备查，界面不再提供原件下载',
      revokedAt: mandate.revokedAt,
    };
  }
}

/** 轻量校验助手：把外部字符串档页标准化。 */
export function normalizeFolio(text) {
  const parsed = parseFolio(text);
  return formatFolio(parsed);
}
