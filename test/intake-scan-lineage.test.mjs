import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InspectionService, PAGE_KIND, PAGE_VERDICT, ScannedPage, ScanPackage, SealRegistry,
} from '../intake/domain/scan-package.js';
import { LineageGraph, LineageRecord, RECORD_KIND } from '../intake/domain/lineage.js';
import { HandoverLedger, HandoverPacket, HANDOVER_MODE } from '../intake/domain/handover.js';
import { AuthorizationError, DomainError, ForeignPageError } from '../intake/domain/errors.js';

function page(overrides = {}) {
  return new ScannedPage({
    kind: PAGE_KIND.ORIGINAL, subject: 'B3', folio: 'OD-5/2',
    sheetRef: 'FR-4/2', ...overrides,
  });
}

test('扫描核验：归属以页头为准，混入 B8 的页扣留不发窗口', () => {
  const service = new InspectionService();
  const pkg = new ScanPackage({
    packageId: 'PKG-1', office: 'old', requestId: 'PR-1',
    pages: [page(), page({ subject: 'B8', folio: 'OD-5/3', sheetRef: 'FR-8/3', sealNo: 'C1' })],
  });
  const result = service.inspect({ pkg, expectedSubject: 'B3' });
  assert.equal(result.releasable.length, 1);
  const blocked = result.blocked[0];
  assert.equal(blocked.verdict, PAGE_VERDICT.FOREIGN_BLOCKED);
  assert.throws(() => service.assertReleasable(blocked.page, 'B3'), ForeignPageError);
});

test('扫描核验：联章待核给出柜台查补页码；查补验明后两笔档卷共用', () => {
  const seals = new SealRegistry();
  const service = new InspectionService(seals);
  // 第一次核验：OD-5/2 联章待核，柜台指 FR-4/3
  const pendingPkg = new ScanPackage({
    packageId: 'PKG-1', office: 'old', requestId: 'PR-1',
    pages: [page({ sealNo: null, sealSourceSheet: 'FR-4/3' })],
  });
  const first = service.inspect({ pkg: pendingPkg, expectedSubject: 'B3' });
  assert.equal(first.blocked[0].verdict, PAGE_VERDICT.PENDING_CROSS_SEAL);
  assert.match(first.blocked[0].note, /FR-4\/3/);

  // 查补回来的单页联章：C1 适用于 OD-5/2 与 OD-7/1
  const sealPage = new ScannedPage({
    kind: PAGE_KIND.SEAL_SHEET, subject: 'B3', folio: 'OD-5/3', sheetRef: 'FR-4/3',
    sealNo: 'C1', sealVerified: true, applicableFolios: ['OD-5/2', 'OD-7/1'],
  });
  seals.register(sealPage);
  const second = service.inspect({ pkg: pendingPkg, expectedSubject: 'B3' });
  assert.equal(second.releasable[0].verdict, PAGE_VERDICT.OK);
  assert.match(second.releasable[0].note, /档卷共用/);

  // 另一笔已许可档卷 OD-7/1 直接共用同一联章依据
  assert.equal(seals.findBasis({ sealNo: 'C1', subject: 'B3', folio: 'OD-7/1' }).pageId,
    sealPage.pageId);
  // B8 的联章号不能拿来补 B3
  assert.equal(seals.findBasis({ sealNo: 'C1', subject: 'B8', folio: 'OD-5/2' }), null);
});

test('扫描核验：别家页是唯一联章依据时转档案员核实，不得自行采用', () => {
  const service = new InspectionService();
  const pkg = new ScanPackage({
    packageId: 'PKG-1', office: 'old', requestId: 'PR-1',
    pages: [
      page({ sealNo: null, sealSourceSheet: 'FR-8/3' }),
      new ScannedPage({
        kind: PAGE_KIND.SEAL_SHEET, subject: 'B8', folio: 'OD-5/3', sheetRef: 'FR-8/3',
        sealNo: 'C1',
      }),
    ],
  });
  const result = service.inspect({ pkg, expectedSubject: 'B3' });
  const hold = result.blocked.find(r => r.verdict === PAGE_VERDICT.ARCHIVIST_HOLD);
  assert.ok(hold);
  assert.equal(service.holds[0].sealNo, 'C1');
});

test('沿革：只有带旧档出处和承接范围的重打件能接上原档', () => {
  const graph = new LineageGraph();
  assert.throws(() => graph.add(new LineageRecord({
    kind: RECORD_KIND.REISSUE, issueNo: 'K5', office: 'new', subject: 'B3',
    folio: 'ND-9/1', sheetRef: 'FR-4/1', issuedAt: 26,
    appliesFrom: 23, appliesUntil: 40,
  })), /旧档出处与承接范围/);

  graph.add(new LineageRecord({
    kind: RECORD_KIND.ISSUE, issueNo: 'K1', office: 'old', subject: 'B3',
    folio: 'OD-5/2', sheetRef: 'FR-4/2', issuedAt: 17,
    appliesFrom: 10, appliesUntil: 22,
  }));
  graph.add(new LineageRecord({
    kind: RECORD_KIND.REISSUE, issueNo: 'K5', office: 'new', subject: 'B3',
    folio: 'ND-9/1', sheetRef: 'FR-4/1', issuedAt: 26,
    appliesFrom: 23, appliesUntil: 40, supersedes: 'K1',
    sourceFolio: 'OD-5/2', successionScope: 'OD-5/2 当前展示',
  }));
  assert.equal(graph.isLinkedToOriginal('OD-5/2'), true);
  const related = graph.relatedTo('OD-5/2');
  assert.deepEqual(related.map(r => r.issueNo), ['K1', 'K5']);
});

test('沿革：原件有效性与是否代表当前声明是两个独立判断', () => {
  const graph = new LineageGraph();
  graph.add(new LineageRecord({
    kind: RECORD_KIND.ISSUE, issueNo: 'K1', office: 'old', subject: 'B3',
    folio: 'OD-5/2', sheetRef: 'FR-4/2', issuedAt: 17,
    appliesFrom: 10, appliesUntil: 22,
  }));
  graph.add(new LineageRecord({
    kind: RECORD_KIND.REISSUE, issueNo: 'K5', office: 'new', subject: 'B3',
    folio: 'ND-9/1', sheetRef: 'FR-4/1', issuedAt: 26,
    appliesFrom: 23, appliesUntil: 40, supersedes: 'K1',
    sourceFolio: 'OD-5/2', successionScope: '承接', confirmed: true,
  }));
  // 查旧时点 t=20：K1 当时有效且代表当前
  const historical = graph.materialsAsOf({ subject: 'B3', at: 20 });
  assert.equal(historical[0].originalValidity, true);
  assert.equal(historical[0].representsCurrent, true);
  // 查当前 t=30：原件已过期，当前声明由 K5 代表
  const current = graph.currentMaterials({ subject: 'B3', at: 30 });
  assert.equal(current[0].originalValidity, false);
  assert.equal(current[0].representsCurrent, true);
  assert.equal(current[0].successor.issueNo, 'K5');
});

test('沿革：后件未确认取得时，当前材料说明缺哪页', () => {
  const graph = new LineageGraph();
  graph.add(new LineageRecord({
    kind: RECORD_KIND.ISSUE, issueNo: 'K1', office: 'old', subject: 'B3',
    folio: 'OD-5/2', sheetRef: 'FR-4/2', issuedAt: 17,
    appliesFrom: 10, appliesUntil: 22,
  }));
  graph.add(new LineageRecord({
    kind: RECORD_KIND.REISSUE, issueNo: 'K5', office: 'new', subject: 'B3',
    folio: 'ND-9/1', sheetRef: 'FR-4/1', issuedAt: 26,
    appliesFrom: 23, appliesUntil: 40, supersedes: 'K1',
    sourceFolio: 'OD-5/2', successionScope: '承接', confirmed: false,
  }));
  const current = graph.currentMaterials({ subject: 'B3', at: 30 });
  assert.equal(current[0].presentation, 'SUCCESSOR_PENDING');
  assert.equal(current[0].missingFolio, 'ND-9/1');
});

test('交接：禁止信用等级结论；撤回后未交接页不得出具', () => {
  assert.throws(() => new HandoverPacket({
    mandateId: 'MA-9', subject: 'B3', mode: HANDOVER_MODE.CURRENT, requestedAt: 30,
    items: [], migrationEvidence: [], note: '该企业信用等级为 A',
  }), DomainError);

  const ledger = new HandoverLedger();
  const fakeMandate = { id: 'MA-9', isRevoked: true, revokedAt: 35 };
  assert.throws(() => ledger.assertCanIssue({
    mandate: fakeMandate, folios: ['OD-5/3'], at: 36,
  }), AuthorizationError);
  // 已交接过的页不拦
  const packet = new HandoverPacket({
    mandateId: 'MA-9', subject: 'B3', mode: HANDOVER_MODE.HISTORICAL, requestedAt: 30,
    items: [{ folio: 'OD-5/2' }], migrationEvidence: [], note: '',
  });
  ledger.add(packet);
  assert.doesNotThrow(() => ledger.assertCanIssue({
    mandate: fakeMandate, folios: ['OD-5/2'], at: 36,
  }));
  assert.equal(ledger.wasHandedOver('MA-9', 'OD-5/2'), true);
});
