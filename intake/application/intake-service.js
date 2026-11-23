/**
 * 跨机关档案收件应用服务。
 * 编排顺序固定为：授权校验 → 同档在途拦截 → 份数预占 → 门户提交 →
 * 异步流水确认受理（受理即扣，窗口关闭也不退）→ 取件核验 → 交还企业。
 * 索引命中只作线索，任何一步都不能用索引结果认定取件成功。
 */
import { AuditLog, AUDIT_KIND } from '../domain/audit-log.js';
import { AuthorizationError, DomainError, QuotaError } from '../domain/errors.js';
import { HandoverLedger, HandoverPacket, HANDOVER_MODE } from '../domain/handover.js';
import { INDEX_STATUS, IndexTask } from '../domain/index-task.js';
import { LineageGraph, LineageRecord, RECORD_KIND } from '../domain/lineage.js';
import { MandateRegistry, normalizeFolio } from '../domain/mandate.js';
import { PullLedger, PullRequest, PULL_STATE } from '../domain/pull-request.js';
import { InspectionService, PAGE_KIND, ScannedPage, ScanPackage, SealRegistry } from '../domain/scan-package.js';
import { QuotaLedgers } from '../domain/quota-ledger.js';

const STATUS_TEXT_TO_STATE = {
  已受理: PULL_STATE.ACCEPTED,
  文件可取: PULL_STATE.AVAILABLE,
  明确未受理: PULL_STATE.REJECTED,
};

export class IntakeService {
  constructor({ clientFactory, clock, mandatesRecords, separableFolios = {} }) {
    this.clock = clock;                 // 注入时钟（演练里为整数时点）
    this.clientFactory = clientFactory; // office -> BrowserPortalClient
    this.registry = MandateRegistry.fromRecords(mandatesRecords);
    this.ledgers = new QuotaLedgers();
    this.pullLedger = new PullLedger();
    this.audit = new AuditLog();
    this.lineage = new LineageGraph();
    this.seals = new SealRegistry();
    this.inspection = new InspectionService(this.seals);
    this.handovers = new HandoverLedger();
    this.indexTasks = new Map();        // key: office|taskNo
    // 门户明确允许单独调取的 folio 白名单（按机关），来源是门户表单服务端校验。
    this.separableFolios = separableFolios;
  }

  now() {
    return this.clock();
  }

  // ── 1. 索引查询（分片） ───────────────────────────────────────────────

  /**
   * 发起/续刷索引查询。每次调用读取门户当前分片并登记；
   * 只回传本企业归属的行——集团同事项号下别家企业行被过滤。
   */
  async searchIndex({ mandateId, office, subject }) {
    const at = this.now();
    // 探测性授权：校验企业归属与批单时点有效；具体档页在领取时逐页校验。
    const mandate = this.registry.get(mandateId);
    if (mandate.subject !== subject || mandate.revisionAt(at) === null) {
      throw new AuthorizationError('当前时点无有效授权，不能发起索引查询', { mandateId, at });
    }
    const client = this.clientFactory(office);
    const page = await client.search(subject);
    const indexEntry = this.audit.record(AUDIT_KIND.INDEX_SEARCH,
      { office, subject, taskNo: page.taskNo, status: page.status }, { at });

    const key = `${office}|${page.taskNo}`;
    if (!this.indexTasks.has(key)) {
      this.indexTasks.set(key, new IndexTask({
        taskNo: page.taskNo, office, subject, indexSerial: indexEntry.serial,
      }));
    }
    const task = this.indexTasks.get(key);
    task.acceptShard({
      at,
      status: page.status === 'SEALED' ? INDEX_STATUS.SEALED : INDEX_STATUS.STREAMING,
      rows: page.rows,
    });
    this.audit.record(AUDIT_KIND.INDEX_SHARD,
      { office, taskNo: page.taskNo, rowCount: page.rows.length }, { at });

    return {
      taskNo: task.taskNo,
      office,
      indexSerial: task.indexSerial,
      status: task.status,
      sealed: task.isSealed,
      rows: task.rowsFor(subject),
      blockedOtherSubjects: page.rows.filter(row => row.subject !== subject)
        .map(row => ({ archiveNo: row.archiveNo, subject: row.subject })),
    };
  }

  // ── 2. 取档请求（份数与状态机的核心） ─────────────────────────────────

  /**
   * 提交取档。folios 为一份取档包（可合并多档号；单页调取只传一项）。
   * 全流程带同档在途拦截与份数预占；门户窗口关闭时保留 SUBMITTED，等流水确认。
   */
  async requestPull({ mandateId, office, subject, folios: rawFolios }) {
    const at = this.now();
    const folios = rawFolios.map(normalizeFolio);
    const separable = this.separableFolios[office];

    // 2.1 授权 + 单页可调取校验（每个档页都要在授权与门户白名单内）。
    for (const folio of folios) {
      this.registry.authorizeSeparable({
        mandateId, subject, office, folio, at, separableFolios: separable,
      });
    }

    // 2.2 同档在途：门户仍可能回件时，同档不耗第二份。
    for (const folio of folios) {
      const blocker = this.pullLedger.pendingFor(subject, office, folio);
      if (blocker) {
        throw new DomainError('PULL_STILL_PENDING',
          '同档请求门户仍可能回件，禁止重复消耗调阅份数', {
            folio, blocker: blocker.requestId, state: blocker.state,
          });
      }
    }

    // 2.3 份数预占（机关独立结算 + 全委托总限额同时校验）。
    const mandate = this.registry.get(mandateId);
    const ledger = this.ledgers.forMandate(mandate);
    const indexSerial = this._latestIndexSerial(office);
    const pullEntry = this.audit.record(AUDIT_KIND.PULL_SUBMIT,
      { office, subject, folios, indexSerial }, { at });
    const request = new PullRequest({
      mandateId, subject, office, folios, at,
      indexSerial, pullSerial: pullEntry.serial,
    });
    this.pullLedger.add(request);
    try {
      request.quotaEntryId = ledger.reserve({ office, requestId: request.requestId, at });
    } catch (error) {
      // 预占失败：请求留在登记册但立即终态（明确未受理），避免阻塞同档后续申请。
      request.transition(PULL_STATE.REJECTED, { at, note: '份数不足，未向门户提交' });
      throw error;
    }
    this.audit.record(AUDIT_KIND.QUOTA,
      { entryId: request.quotaEntryId, action: 'RESERVE', office }, { at });

    // 2.4 门户提交。窗口关闭不是失败——受理可能随后出现在流水页。
    const client = this.clientFactory(office);
    // 422 表单拒绝会抛 FolioNotSeparableError：预占随之释放，请求标记未受理。
    let response;
    try {
      response = await client.submitPull({ subject, folios });
    } catch (error) {
      if (error instanceof DomainError) {
        ledger.release({ requestId: request.requestId, at, reason: error.code });
        request.transition(PULL_STATE.REJECTED, { at, note: error.message });
        this.audit.record(AUDIT_KIND.PULL_REJECTED,
          { requestId: request.requestId, reason: error.code }, { at });
      }
      throw error;
    }

    if (response.outcome === 'ACCEPTED') {
      request.transition(PULL_STATE.ACCEPTED, { at, acceptanceNo: response.acceptanceNo });
      ledger.confirmAccepted({ requestId: request.requestId, at });
      this.audit.record(AUDIT_KIND.PULL_ACCEPTED,
        { requestId: request.requestId, acceptanceNo: response.acceptanceNo, office }, { at });
    }
    // CONNECTION_CLOSED：保持 SUBMITTED，等待 reconcileRequests() 回流水确认。
    return request;
  }

  /**
   * 对账异步流水页：把门户受理结论同步进状态机。
   * 处理“窗口关闭后受理仍成立并扣份”和“迟到受理占掉留给另一机关的最后一份”。
   */
  async reconcileRequests() {
    const at = this.now();
    const offices = new Set(this.pullLedger.requests.map(request => request.office));
    const results = [];
    for (const office of offices) {
      const client = this.clientFactory(office);
      const stream = await client.fetchRequestStream();
      for (const item of stream.items) {
        const request = this.pullLedger.requests.find(candidate =>
          candidate.office === item.office
          && candidate.folios.includes(item.folio)
          && !candidate.isTerminal);
        if (!request) continue;
        const ledger = this.ledgers.forMandate(this.registry.get(request.mandateId));
        const next = STATUS_TEXT_TO_STATE[item.statusText];
        results.push(await this._applyPortalState({ request, next, item, ledger, at }));
      }
    }
    return results;
  }

  async _applyPortalState({ request, next, item, ledger, at }) {
    const from = request.state;
    if (next === PULL_STATE.REJECTED) {
      if (from === PULL_STATE.SUBMITTED) {
        ledger.release({ requestId: request.requestId, at, reason: '门户明确未受理' });
        request.transition(PULL_STATE.REJECTED, { at, note: '门户明确未受理，份数释放' });
        this.audit.record(AUDIT_KIND.PULL_REJECTED, { requestId: request.requestId }, { at });
      }
    } else if (next === PULL_STATE.ACCEPTED || next === PULL_STATE.AVAILABLE) {
      const late = from === PULL_STATE.EXPIRED;
      if (from === PULL_STATE.SUBMITTED || from === PULL_STATE.EXPIRED) {
        try {
          ledger.confirmAccepted({ requestId: request.requestId, at, late });
        } catch (error) {
          if (error instanceof QuotaError) {
            // 迟到受理与已释放份数冲突：记录冲突但受理仍成立，交人工裁决。
            request.transition(PULL_STATE.LATE_ACCEPTED,
              { at, acceptanceNo: item.acceptanceNo, note: '迟到受理，份数透支待裁决' });
            this.audit.record(AUDIT_KIND.PULL_LATE_ACCEPTED,
              { requestId: request.requestId, acceptanceNo: item.acceptanceNo, error: error.details }, { at });
            return { requestId: request.requestId, conflict: error.details };
          }
          throw error;
        }
        request.transition(late ? PULL_STATE.LATE_ACCEPTED : PULL_STATE.ACCEPTED,
          { at, acceptanceNo: item.acceptanceNo, note: late ? '窗口关闭后的迟到受理，份数照扣' : '门户已受理，份数扣定' });
        this.audit.record(late ? AUDIT_KIND.PULL_LATE_ACCEPTED : AUDIT_KIND.PULL_ACCEPTED,
          { requestId: request.requestId, acceptanceNo: item.acceptanceNo }, { at });
      }
      if (next === PULL_STATE.AVAILABLE
        && [PULL_STATE.ACCEPTED, PULL_STATE.LATE_ACCEPTED].includes(request.state)) {
        request.transition(PULL_STATE.AVAILABLE, { at, acceptanceNo: item.acceptanceNo });
        this.audit.record(AUDIT_KIND.PULL_AVAILABLE,
          { requestId: request.requestId, scanPath: item.scanPath }, { at });
      }
    }
    return { requestId: request.requestId, state: request.state, acceptanceNo: request.acceptanceNo };
  }

  /** 窗口关闭且超过回件观察期：先过期（释放预占）；迟到受理仍可随后追扣。 */
  expireRequest(requestId, reason = '门户回件窗口关闭，暂无受理结论') {
    const at = this.now();
    const request = this._mustFind(requestId);
    const ledger = this.ledgers.forMandate(this.registry.get(request.mandateId));
    if (request.state === PULL_STATE.SUBMITTED) {
      ledger.release({ requestId, at, reason });
      request.transition(PULL_STATE.EXPIRED, { at, note: reason });
      this.audit.record(AUDIT_KIND.PULL_EXPIRED, { requestId, reason }, { at });
    }
    return request;
  }

  // ── 3. 异步取档与扫描核验 ─────────────────────────────────────────────

  /**
   * 文件可取后取档：请求正式收据并拉取扫描包，逐页核验归属与联章。
   * 混入别家企业的页扣留；若是获批页唯一联章依据，转档案员核实。
   */
  async retrieveAndInspect({ requestId, scanPaths }) {
    const at = this.now();
    const request = this._mustFind(requestId);
    if (request.state !== PULL_STATE.AVAILABLE) {
      throw new DomainError('ILLEGAL_STATE', '只有“文件可取”的请求才能异步取档', {
        requestId, state: request.state,
      });
    }
    const client = this.clientFactory(request.office);
    const pages = [];
    const parsedScans = [];
    for (const path of scanPaths) {
      const parsed = await client.fetchScan(path);
      parsedScans.push({ path, parsed });
      pages.push(this._toScannedPage(parsed, path, request));
    }
    const pkg = new ScanPackage({
      packageId: `PKG-${request.requestId}`,
      office: request.office,
      requestId,
      pages,
    });
    const verdict = this.inspection.inspect({ pkg, expectedSubject: request.subject });
    request.transition(verdict.blocked.length
      ? PULL_STATE.QUARANTINED
      : PULL_STATE.RETRIEVED, { at, note: `取档完成，${verdict.blocked.length} 页扣留` });

    // 正式收据在异步取档页请求后取得。
    const receipt = this.audit.record(AUDIT_KIND.PULL_RECEIPT, {
      requestId,
      acceptanceNo: request.acceptanceNo,
      packageId: pkg.packageId,
      releasable: verdict.releasable.map(item => item.pageId),
      blocked: verdict.blocked.map(item => ({ pageId: item.pageId, verdict: item.verdict, note: item.note })),
    }, { at });
    request.receiptNo = receipt.serial;
    this.audit.record(AUDIT_KIND.INSPECTION, { requestId, verdict: verdict.allResults.map(item => ({
      pageId: item.pageId, verdict: item.verdict, note: item.note,
    })) }, { at });

    for (const page of pages) {
      if (page.sealNo && page.sealVerified) this.seals.register(page);
    }
    return { request, pkg, verdict, receiptNo: request.receiptNo, parsedScans };
  }

  /** 登记单页联章（柜台查补回来的页；只能在授权内申请单独页）。 */
  registerSealPage({ mandateId, office, subject, folio, parsed, at = this.now() }) {
    this.registry.authorizeSeparable({
      mandateId, subject, office, folio, at, separableFolios: this.separableFolios[office],
    });
    const page = this._toScannedPage(parsed, null, { subject, office });
    this.seals.register(page);
    return page;
  }

  /** 档案员核实后解除扣留（给出核实结论与替代联章依据）。 */
  resolveArchivistHold(requestId, resolution) {
    const request = this._mustFind(requestId);
    if (request.state !== PULL_STATE.QUARANTINED) {
      throw new DomainError('ILLEGAL_STATE', '只有扣留中的请求需要档案员核实', { requestId });
    }
    this.audit.record(AUDIT_KIND.INSPECTION, { requestId, resolution, action: 'ARCHIVIST_RESOLVE' },
      { at: this.now() });
    request.transition(PULL_STATE.RETRIEVED, { at: this.now(), note: '档案员核实完成' });
    return request;
  }

  // ── 4. 沿革登记与企业交接 ─────────────────────────────────────────────

  /** 从扫描页要素登记签发/重打/交接沿革（重打必须带旧档出处与承接范围）。 */
  recordFromScan(parsed, { kind }) {
    const { issue, applicability, replacement } = parsed;
    if (!issue || !applicability) {
      throw new DomainError('PORTAL_CONTRACT', '扫描页缺少签发要素，不能登记沿革', { parsed });
    }
    const record = new LineageRecord({
      kind,
      issueNo: issue.issueNo,
      office: issue.office === '原机关' ? 'old' : 'new',
      subject: applicability.subject,
      folio: `${issue.archiveNo}/${issue.sheetRef.split('/')[1]}`,
      sheetRef: issue.sheetRef,
      issuedAt: applicability.issuedAt,
      appliesFrom: applicability.appliesFrom,
      appliesUntil: applicability.appliesUntil,
      supersedes: replacement?.supersedes ?? null,
      sourceFolio: replacement?.sourceFolio ?? null,
      successionScope: replacement ? `承接 ${replacement.sourceFolio} 的当前展示` : null,
    });
    return this.lineage.add(record);
  }

  /** 登记机关迁移交接（资料迁出证据）。 */
  recordTransfer({ mandateId, transfer, at }) {
    const record = new LineageRecord({
      kind: RECORD_KIND.TRANSFER,
      issueNo: `TR-${transfer.from}-${transfer.to}`,
      office: transfer.to,
      subject: this.registry.get(mandateId).subject,
      folio: transfer.new,
      sourceFolio: transfer.old,
      successionScope: `${transfer.old} → ${transfer.new}`,
      transferAt: transfer.at,
      issuedAt: transfer.at,
      appliesFrom: transfer.at,
      appliesUntil: Number.POSITIVE_INFINITY,
      note: `机关迁移：资料于时点 ${transfer.at} 由 ${transfer.from} 迁出，${transfer.to} 承接`,
    });
    return this.lineage.add(record);
  }

  /**
   * 交还企业核对。
   * HISTORICAL：查旧时点，见当时材料（原件有效性与当前代表性分开标注）；
   * CURRENT：查当前材料，已确认后件或注明尚未取得哪页。
   * 必带迁出证据；撤回后未交接页不得出具；文案禁止信用等级结论。
   */
  async handover({ mandateId, subject, mode, at = this.now(), note = '' }) {
    const mandate = this.registry.get(mandateId);
    const materials = mode === HANDOVER_MODE.HISTORICAL
      ? this.lineage.materialsAsOf({ subject, at })
      : this.lineage.currentMaterials({ subject, at });
    if (!materials.length) {
      throw new DomainError('NO_MATERIAL', '暂无已取档材料可交接', { mandateId });
    }
    const folios = materials.map(entry =>
      mode === HANDOVER_MODE.HISTORICAL ? entry.record.folio : entry.source.folio);
    this.handovers.assertCanIssue({ mandate, folios, at });

    const migrationEvidence = this.lineage.records
      .filter(record => record.kind === RECORD_KIND.TRANSFER && record.subject === subject)
      .map(record => ({
        transferAt: record.transferAt, sourceFolio: record.sourceFolio,
        targetFolio: record.folio, scope: record.successionScope,
      }));

    const items = HandoverLedger.buildItems({ mode, materials, at });
    const packet = new HandoverPacket({
      mandateId, subject, mode, requestedAt: at, items, migrationEvidence, note,
    });
    this.handovers.add(packet);
    this.audit.record(AUDIT_KIND.HANDOVER, {
      handoverId: packet.handoverId, mode, items: items.length,
      folios, migrationEvidence,
    }, { at });

    for (const request of this.pullLedger.requests.filter(r =>
      r.subject === subject && r.state === PULL_STATE.RETRIEVED
      && r.folios.some(folio => folios.includes(folio)))) {
      request.transition(PULL_STATE.HANDED_OVER, { at, note: `随交接包 ${packet.handoverId} 交还` });
    }
    return packet;
  }

  // ── 5. 经办人员查询 ───────────────────────────────────────────────────

  /** 各档请求可重领时点、状态、受理号、收据号。 */
  requestStatus(subject, office, folio) {
    return this.pullLedger.statusForFolio(subject, office, normalizeFolio(folio));
  }

  /** 调阅余额与归属（机关独立结算 + 总限额）。 */
  balances() {
    return this.ledgers.allBalances();
  }

  /** 找全相互关联的签发、替代及交接记录。 */
  lineageOf(folio) {
    return this.lineage.relatedTo(normalizeFolio(folio));
  }

  /** 授权撤回后的下载许可（界面按此决定是否保留原件入口）。 */
  downloadPolicy({ mandateId, folio, at = this.now() }) {
    return this.registry.downloadPermitted({
      mandateId, folio: normalizeFolio(folio), handoverLedger: this.handovers, at,
    });
  }

  /** 档案员核实队列。 */
  archivistHolds() {
    return this.inspection.holds;
  }

  // ── 内部助手 ──────────────────────────────────────────────────────────

  _mustFind(requestId) {
    const request = this.pullLedger.requests.find(candidate => candidate.requestId === requestId);
    if (!request) throw new DomainError('REQUEST_NOT_FOUND', `找不到取档请求 ${requestId}`, { requestId });
    return request;
  }

  _latestIndexSerial(office) {
    const trail = this.audit.indexTrail()
      .filter(entry => entry.payload.office === office);
    return trail.at(-1)?.serial ?? null;
  }

  _toScannedPage(parsed, path, request) {
    const kind = parsed.header.includes('重打') ? PAGE_KIND.REISSUE
      : parsed.header.includes('更正') ? PAGE_KIND.CORRECTION
        : parsed.header.includes('联章') ? PAGE_KIND.SEAL_SHEET
          : PAGE_KIND.ORIGINAL;
    // 单页联章没有档号要素，其 folio 取适用档卷的第一项，册页坐标保留 FR 引用。
    const folio = parsed.issue
      ? `${parsed.issue.archiveNo}/${parsed.issue.sheetRef.split('/')[1]}`
      : (parsed.seal?.applicableTo?.[0] ?? request.folios?.[0] ?? null);
    return new ScannedPage({
      kind,
      subject: parsed.applicability?.subject ?? parsed.seal?.subject ?? request.subject,
      folio,
      sheetRef: parsed.issue?.sheetRef ?? parsed.seal?.sheetRef ?? null,
      sealNo: parsed.seal?.status === 'VERIFIED' || parsed.seal?.status === 'STANDALONE'
        ? parsed.seal.sealNo
        : null,
      sealVerified: parsed.seal?.status === 'VERIFIED' || parsed.seal?.status === 'STANDALONE',
      sealSourceSheet: parsed.seal?.status === 'PENDING' ? parsed.seal.counterSheet : null,
      applicableFolios: parsed.seal?.applicableTo ?? [],
      note: path ? `来源 ${path}` : parsed.text.slice(0, 60),
    });
  }
}
