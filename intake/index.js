/**
 * 跨机关档案收件模块公共入口。
 * 窗口应用只依赖这里导出的应用服务与领域常量，不直接触碰内部实现。
 */
export { IntakeService } from './application/intake-service.js';
export { BrowserPortalClient } from './infrastructure/portal-client.js';
export {
  parseArchiveHome,
  parseSearchPage,
  parseRequestsPage,
  parsePullResponse,
  parseScanPage,
  parsePackageManifest,
} from './infrastructure/html-parser.js';

export { Mandate, MandateRegistry, MandateRevision } from './domain/mandate.js';
export { IndexTask, INDEX_STATUS } from './domain/index-task.js';
export { PullRequest, PullLedger, PULL_STATE } from './domain/pull-request.js';
export { QuotaLedger, QuotaLedgers, QUOTA_ENTRY } from './domain/quota-ledger.js';
export {
  InspectionService, ScanPackage, ScannedPage, SealRegistry,
  PAGE_KIND, PAGE_VERDICT,
} from './domain/scan-package.js';
export { LineageGraph, LineageRecord, RECORD_KIND } from './domain/lineage.js';
export { HandoverPacket, HandoverLedger, HANDOVER_MODE } from './domain/handover.js';
export { AuditLog, AUDIT_KIND } from './domain/audit-log.js';
export {
  DomainError, AuthorizationError, FolioNotSeparableError, PendingPullError,
  QuotaError, ForeignPageError, IllegalStateError, PortalContractError,
} from './domain/errors.js';
