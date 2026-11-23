/**
 * 端到端收件流程：直接对接演练来源（真实 HTML 页面、表单、阶段切换），
 * 验证从索引分片到企业交接的完整链路与全部硬约束。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { startSources } from '../sources/server.mjs';
import { BrowserPortalClient } from '../intake/infrastructure/portal-client.js';
import { IntakeService } from '../intake/application/intake-service.js';
import { HANDOVER_MODE } from '../intake/domain/handover.js';
import { PULL_STATE } from '../intake/domain/pull-request.js';
import { PAGE_VERDICT } from '../intake/domain/scan-package.js';
import {
  AuthorizationError, DomainError, FolioNotSeparableError, PendingPullError,
} from '../intake/domain/errors.js';

const mandatesRecords = JSON.parse(await readFile(new URL('../data/mandates.json', import.meta.url)));

// 门户表单服务端校验白名单（与 data/sources.json 的 form.folio 一致）。
// quotaReview 阶段 old 机关开放 OD-5/3 单页查补（联章页只能在授权内单独申请）。
const SEPARABLE = {
  old: ['OD-5/2', 'OD-5/3', 'OD-7/1'],
  new: ['ND-9/1'],
};

async function harness(clockValues) {
  const source = await startSources();
  let tick = 0;
  const clients = new Map();
  // 深拷贝白名单：单个用例收紧门户权限不得污染其他用例的共享常量。
  const separable = JSON.parse(JSON.stringify(SEPARABLE));
  const service = new IntakeService({
    mandatesRecords,
    separableFolios: separable,
    // 时钟序列耗尽后停在最后一个值；需要精确时点的用例显式传 at。
    clock: () => clockValues[Math.min(tick++, clockValues.length - 1)],
    clientFactory: office => {
      if (!clients.has(office)) {
        clients.set(office, new BrowserPortalClient({ baseUrl: source.url, office }));
      }
      return clients.get(office);
    },
  });
  return {
    source, service,
    old: () => clients.get('old'),
    new: () => clients.get('new'),
    scenario: stage => service.clientFactory('old').setScenario(stage),
  };
}

test('E2E：索引分片只作线索，同事项号别家企业行被过滤', async () => {
  const h = await harness([18, 18]);
  try {
    // 原机关索引已封：OD-5 下同时有 B3 与 B8 的行
    const result = await h.service.searchIndex({ mandateId: 'MA-9', office: 'old', subject: 'B3' });
    assert.equal(result.status, 'SEALED');
    assert.equal(result.rows.every(row => row.subject === 'B3'), true);
    assert.deepEqual(result.blockedOtherSubjects, [{ archiveNo: 'OD-5', subject: 'B8' }]);
    // 承接机关仍在出页（STREAMING）
    const streaming = await h.service.searchIndex({ mandateId: 'MA-9', office: 'new', subject: 'B3' });
    assert.equal(streaming.status, 'STREAMING');
    assert.equal(streaming.sealed, false);
    // 索引流水独立编号，且不能据此认定取件成功
    assert.match(result.indexSerial, /^IX-/);
    assert.equal(h.service.requestStatus('B3', 'old', 'OD-5/2').length, 0);
  } finally {
    await h.source.close();
  }
});

test('E2E：窗口关闭后受理仍成立并扣份；同档在途不允许再耗一份', async () => {
  const h = await harness([18, 18, 19, 19, 20]);
  try {
    const request = await h.service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
    // 门户页面连接已关闭：请求保持 SUBMITTED，份数处于预占
    assert.equal(request.state, PULL_STATE.SUBMITTED);
    assert.equal(h.service.balances()[0].perOffice.old.held, 1);

    // 同档立即再申请：拦截，不能消耗第二份
    await assert.rejects(
      () => h.service.requestPull({
        mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
      }),
      error => error instanceof PendingPullError || error.code === 'PULL_STILL_PENDING',
    );

    // 回流水页对账：W5 已受理，份数扣定（窗口关闭不回退受理）
    const reconciled = await h.service.reconcileRequests();
    const accepted = reconciled.find(r => r.requestId === request.requestId);
    assert.equal(accepted.state, PULL_STATE.ACCEPTED);
    assert.equal(accepted.acceptanceNo, 'W5');
    const balance = h.service.balances()[0];
    assert.equal(balance.perOffice.old.consumed, 1);
    assert.equal(balance.perOffice.old.held, 0);
  } finally {
    await h.source.close();
  }
});

test('E2E：授权外或门户不可单独调取的页被拒，不产生受理不扣份', async () => {
  const h = await harness([20, 20]);
  try {
    // OD-5/3 在授权内，但构造一个门户白名单外的页：直接调领域校验
    await assert.rejects(
      () => h.service.requestPull({
        mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['ND-9/1'],
      }),
      AuthorizationError,
    );
    // B8 不能用 B3 的批单
    await assert.rejects(
      () => h.service.requestPull({
        mandateId: 'MA-9', office: 'old', subject: 'B8', folios: ['OD-5/2'],
      }),
      AuthorizationError,
    );
    // 白名单收紧时，授权内页也不可单独领取（该服务实例独立，不影响其他用例）
    h.service.separableFolios.old = ['OD-5/2'];
    await assert.rejects(
      () => h.service.requestPull({
        mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/3'],
      }),
      FolioNotSeparableError,
    );
    // 所有拒绝都发生在份数预占之前：没有任何台账被建立
    assert.equal(h.service.balances().length, 0);
  } finally {
    await h.source.close();
  }
});

test('E2E：取档核验拦截别家企业扫描页，唯一联章依据转档案员核实', async () => {
  const h = await harness([18, 19, 20, 21, 21, 22, 22]);
  try {
    const request = await h.service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
    await h.service.reconcileRequests();
    await h.scenario('released');
    // 再次对账：W5 文件可取
    const again = await h.service.reconcileRequests();
    assert.equal(again.find(r => r.requestId === request.requestId).state, PULL_STATE.AVAILABLE);

    // 取扫描包：清单里第二页归属 B8（FR-8/3）
    const manifest = await h.old().fetchPackageManifest('/scans/OD-5-package');
    assert.equal(manifest[1].label, 'FR-8/3 · B8');

    const { verdict } = await h.service.retrieveAndInspect({
      requestId: request.requestId,
      scanPaths: ['/scans/OD-5-2', '/scans/OD-5-3-mismatch'],
    });
    // B3 本页联章待核（柜台指 FR-4/3），B8 页扣留且成为唯一联章依据 -> 档案员核实
    const verdicts = verdict.allResults.map(r => r.verdict);
    assert.ok(verdicts.includes(PAGE_VERDICT.ARCHIVIST_HOLD));
    assert.ok(verdicts.includes(PAGE_VERDICT.FOREIGN_BLOCKED));
    assert.equal(h.service.archivistHolds().length, 1);
    // 扣留页绝不出现在可发窗口清单
    assert.equal(verdict.releasable.some(r => r.page.subject === 'B8'), false);
  } finally {
    await h.source.close();
  }
});

test('E2E：查补单页联章验明后，两笔已许可档卷共用同一依据', async () => {
  const h = await harness([18, 19, 20, 21, 22, 23, 24, 25]);
  try {
    const request = await h.service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
    await h.service.reconcileRequests();
    await h.scenario('handed');
    await h.service.reconcileRequests();
    // handed 阶段 OD-5/2 已带验明联章（C1 来自旧页 FR-4/3）
    const { verdict } = await h.service.retrieveAndInspect({
      requestId: request.requestId, scanPaths: ['/scans/OD-5-2'],
    });
    assert.equal(verdict.releasable.length, 1);

    // 单页联章 FR-4/3：C1 适用于 OD-5/2、OD-7/1
    const sealParsed = await h.old().fetchScan('/scans/OD-5-3');
    const sealPage = h.service.registerSealPage({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folio: 'OD-5/3', parsed: sealParsed,
    });
    assert.equal(sealPage.sealNo, 'C1');
    assert.deepEqual(sealPage.applicableFolios, ['OD-5/2', 'OD-7/1']);
    // 两笔档卷都能解析到同一联章依据
    assert.ok(h.service.seals.findBasis({ sealNo: 'C1', subject: 'B3', folio: 'OD-7/1' }));
  } finally {
    await h.source.close();
  }
});

test('E2E：迁移沿革对接——查旧见原件、查当前见已确认重打件，两判断分开', async () => {
  const h = await harness([18, 19, 20, 24, 25, 26, 27, 28, 30, 30]);
  try {
    // 原机关取件并登记原始签发 K1
    const oldReq = await h.service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
    await h.service.reconcileRequests();
    await h.scenario('handed');
    await h.service.reconcileRequests();
    const oldRetrieved = await h.service.retrieveAndInspect({
      requestId: oldReq.requestId, scanPaths: ['/scans/OD-5-2'],
    });
    assert.equal(oldRetrieved.verdict.releasable.length, 1);
    h.service.recordFromScan(oldRetrieved.parsedScans[0].parsed, { kind: 'ISSUE' });

    // 承接机关取重打件 K5（带旧档出处与承接范围）
    const newReq = await h.service.requestPull({
      mandateId: 'MA-9', office: 'new', subject: 'B3', folios: ['ND-9/1'],
    });
    await h.service.reconcileRequests();
    const newScan = await h.new().fetchScan('/scans/ND-9-1');
    h.service.recordFromScan(newScan, { kind: 'REISSUE' });
    // 迁移交接证据
    const transfer = mandatesRecords[0].transfer;
    h.service.recordTransfer({ mandateId: 'MA-9', transfer, at: transfer.at });

    // 沿革找全 K1、K5 与交接记录
    const related = h.service.lineageOf('OD-5/2');
    const issueNos = related.map(r => r.issueNo);
    assert.ok(issueNos.includes('K1'));
    assert.ok(issueNos.includes('K5'));
    assert.ok(issueNos.includes('TR-old-new'));

    // 查旧时点 t=20：当时材料 K1，原件有效
    const historical = await h.service.handover({
      mandateId: 'MA-9', subject: 'B3', mode: HANDOVER_MODE.HISTORICAL, at: 20,
    });
    const oldItem = historical.items.find(i => i.issueNo === 'K1');
    assert.equal(oldItem.originalValidity, true);
    assert.equal(oldItem.representsCurrent, true);
    assert.ok(historical.migrationEvidence.length >= 1);

    // 查当前 t=30：K5 已确认，原件有效性与当前代表性分离
    const current = await h.service.handover({
      mandateId: 'MA-9', subject: 'B3', mode: HANDOVER_MODE.CURRENT, at: 30,
    });
    const k5 = current.items.find(i => i.issueNo === 'K5');
    assert.equal(k5.representsCurrent, true);
    assert.equal(k5.sourceFolio, 'OD-5/2');
  } finally {
    await h.source.close();
  }
});

test('E2E：撤回后未交接页不得出具，已交接凭据保留但停止原件下载', async () => {
  // 用可变当前时点驱动，避免按调用次数硬数时钟序列。
  let currentAt = 18;
  const source = await startSources();
  const clients = new Map();
  const service = new IntakeService({
    mandatesRecords,
    separableFolios: JSON.parse(JSON.stringify(SEPARABLE)),
    clock: () => currentAt,
    clientFactory: office => {
      if (!clients.has(office)) {
        clients.set(office, new BrowserPortalClient({ baseUrl: source.url, office }));
      }
      return clients.get(office);
    },
  });
  try {
    const req = await service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
    await service.reconcileRequests();
    await clients.get('old').setScenario('handed');
    await service.reconcileRequests();
    const retrieved = await service.retrieveAndInspect({
      requestId: req.requestId, scanPaths: ['/scans/OD-5-2'],
    });
    assert.equal(retrieved.verdict.releasable.length, 1);
    service.recordFromScan(retrieved.parsedScans[0].parsed, { kind: 'ISSUE' });
    service.recordTransfer({ mandateId: 'MA-9', transfer: mandatesRecords[0].transfer, at: 23 });
    // t=30 完成一次交接
    currentAt = 30;
    const packet = await service.handover({
      mandateId: 'MA-9', subject: 'B3', mode: HANDOVER_MODE.HISTORICAL, at: 30,
    });
    assert.ok(packet.handoverId);

    // t=36 授权已撤回：不能再领取
    currentAt = 36;
    await assert.rejects(
      () => service.requestPull({
        mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
      }),
      AuthorizationError,
    );
    // 已交接页：凭据保留、原件下载停止
    const policy = service.downloadPolicy({ mandateId: 'MA-9', folio: 'OD-5/2', at: 36 });
    assert.equal(policy.permitted, false);
    assert.equal(policy.evidenceRetained, true);
    // 未交接页同样停止且无凭据标记
    const policy2 = service.downloadPolicy({ mandateId: 'MA-9', folio: 'OD-7/1', at: 36 });
    assert.equal(policy2.permitted, false);
    assert.equal(policy2.evidenceRetained, undefined);
  } finally {
    await source.close();
  }
});

test('E2E：交接文案禁止信用等级结论，窗口不代办信用修复', async () => {
  const h = await harness([18, 19, 20, 24, 25, 26, 30]);
  try {
    const req = await h.service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
    await h.service.reconcileRequests();
    await h.scenario('handed');
    await h.service.reconcileRequests();
    const retrieved = await h.service.retrieveAndInspect({ requestId: req.requestId, scanPaths: ['/scans/OD-5-2'] });
    h.service.recordFromScan(retrieved.parsedScans[0].parsed, { kind: 'ISSUE' });
    h.service.recordTransfer({ mandateId: 'MA-9', transfer: mandatesRecords[0].transfer, at: 23 });
    await assert.rejects(
      () => h.service.handover({
        mandateId: 'MA-9', subject: 'B3', mode: HANDOVER_MODE.HISTORICAL, at: 30,
        note: '据此宣布企业信用等级为 A',
      }),
      error => error instanceof DomainError && error.code === 'RATING_CLAIM_FORBIDDEN',
    );
  } finally {
    await h.source.close();
  }
});

test('E2E：不同企业委托互不影响，B8 可在 B3 冻结时继续查找', async () => {
  const h = await harness([18, 19, 20, 21, 22, 23]);
  try {
    // B3 正常领一份
    const b3 = await h.service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
    await h.service.reconcileRequests();
    assert.equal(b3.state !== PULL_STATE.REJECTED, true);
    // B8 用自己的批单查询：单条提示页也能解析为已封索引
    const b8Index = await h.service.searchIndex({ mandateId: 'MA-12', office: 'old', subject: 'B8' });
    assert.equal(b8Index.rows[0].subject, 'B8');
    // B8 独立领取：与 B3 的份数、在途状态完全隔离。
    // 演练门户的 old 表单只配置了 B3，B8 提交会被 422 拒绝（未受理、不扣份），
    // 但 B8 自己的台账已独立建立，不受 B3 任何状态影响。
    await assert.rejects(
      () => h.service.requestPull({
        mandateId: 'MA-12', office: 'old', subject: 'B8', folios: ['OD-5/2'],
      }),
      error => error.code === 'FOLIO_NOT_SEPARABLE',
    );
    const balances = h.service.balances();
    assert.deepEqual(balances.map(b => b.subject).sort(), ['B3', 'B8']);
    const b8Balance = balances.find(b => b.subject === 'B8');
    assert.equal(b8Balance.mandateId, 'MA-12');
    assert.equal(b8Balance.perOffice.old.limit, 1);
    assert.equal(b8Balance.perOffice.old.available, 1);
    assert.equal(b8Balance.perOffice.old.consumed, 0);
  } finally {
    await h.source.close();
  }
});

test('E2E：quotaReview 迟到受理 W6 进入流水，份数按机关与总限额独立可见', async () => {
  const h = await harness([18, 19, 20, 21]);
  try {
    // 第一笔 OD-5/2：窗口关闭提交 -> 流水确认 W5 受理扣份
    const first = await h.service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
    await h.service.reconcileRequests();
    assert.equal(first.state, PULL_STATE.ACCEPTED);

    // 门户切到 quotaReview：流水页多出迟到的 W6（OD-5/3 已受理）
    await h.scenario('quotaReview');
    const stream = await h.old().fetchRequestStream();
    const w6 = stream.items.find(item => item.acceptanceNo === 'W6');
    assert.ok(w6, 'quotaReview 流水应包含迟到受理 W6');
    assert.equal(w6.folio, 'OD-5/3');
    assert.equal(w6.statusText, '已受理');

    // W5 与 W6 同属 old 机关但受理号不同，各自可复核；同名 W5 在 new 机关另算
    const w5Status = h.service.requestStatus('B3', 'old', 'OD-5/2');
    assert.equal(w5Status[0].acceptanceNo, 'W5');
    // 受理即扣：old 机关已用 1 份，余额对经办人员可见
    const balance = h.service.balances()[0];
    assert.equal(balance.perOffice.old.consumed, 1);
    assert.equal(balance.perOffice.old.limit, 2);
    assert.equal(balance.total.limit, 2);
  } finally {
    await h.source.close();
  }
});
