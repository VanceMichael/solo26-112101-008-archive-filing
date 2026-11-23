/**
 * 领域错误：全部携带可读的业务原因，窗口界面据此提示，不吞掉异常。
 */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

/** 授权批单不覆盖该企业 / 档页 / 时点，或授权已撤回。 */
export class AuthorizationError extends DomainError {
  constructor(message, details = {}) {
    super('AUTHORIZATION_DENIED', message, details);
    this.name = 'AuthorizationError';
  }
}

/** 门户表单明确不允许该页单独调取（授权只覆盖部分册页时的硬约束）。 */
export class FolioNotSeparableError extends DomainError {
  constructor(message, details = {}) {
    super('FOLIO_NOT_SEPARABLE', message, details);
    this.name = 'FolioNotSeparableError';
  }
}

/** 同档请求门户仍可能回件，禁止再耗一份调阅份数。 */
export class PendingPullError extends DomainError {
  constructor(message, details = {}) {
    super('PULL_STILL_PENDING', message, details);
    this.name = 'PendingPullError';
  }
}

/** 调阅份数（机关独立结算或全委托总限额）不足，或迟到受理造成透支待裁决。 */
export class QuotaError extends DomainError {
  constructor(message, details = {}) {
    super('QUOTA_EXHAUSTED', message, details);
    this.name = 'QuotaError';
  }
}

/** 扫描页归属与委托企业不一致，不得发给窗口比对。 */
export class ForeignPageError extends DomainError {
  constructor(message, details = {}) {
    super('FOREIGN_PAGE_BLOCKED', message, details);
    this.name = 'ForeignPageError';
  }
}

/** 扫描件状态不允许当前转换（如未受理却要求取件）。 */
export class IllegalStateError extends DomainError {
  constructor(message, details = {}) {
    super('ILLEGAL_STATE', message, details);
    this.name = 'IllegalStateError';
  }
}

/** 旧门户返回了无法解释的页面或表单拒绝。 */
export class PortalContractError extends DomainError {
  constructor(message, details = {}) {
    super('PORTAL_CONTRACT', message, details);
    this.name = 'PortalContractError';
  }
}
