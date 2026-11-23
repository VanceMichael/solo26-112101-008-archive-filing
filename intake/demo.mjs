/**
 * 跨机关档案收件演示（可直接运行）。
 * 启动方式：先 `npm run sources`，再 `node intake/demo.mjs`；
 * 或独立运行：本脚本会自行拉起一个演练来源服务，跑完即关闭。
 *
 * 演示覆盖：索引分片 → 授权与单页校验 → 取档份数预占/受理扣份 →
 * 窗口关闭后流水确认 → 扫描归属与联章核验 → 迁移沿革 → 企业交接 → 撤回停效。
 */
import { readFile } from 'node:fs/promises';
import { startSources } from '../sources/server.mjs';
import { IntakeService, BrowserPortalClient, HANDOVER_MODE, PULL_STATE } from './index.js';

const mandatesRecords = JSON.parse(await readFile(new URL('../data/mandates.json', import.meta.url)));
const source = await startSources();
let now = 18;
const clients = new Map();

const service = new IntakeService({
  mandatesRecords,
  separableFolios: {
    old: ['OD-5/2', 'OD-5/3', 'OD-7/1'],
    new: ['ND-9/1'],
  },
  clock: () => now,
  clientFactory: office => {
    if (!clients.has(office)) {
      clients.set(office, new BrowserPortalClient({ baseUrl: source.url, office }));
    }
    return clients.get(office);
  },
});

const line = title => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 48 - title.length))}`);

try {
  line('1. 索引查询（原机关，分片已封）');
  const index = await service.searchIndex({ mandateId: 'MA-9', office: 'old', subject: 'B3' });
  console.log('任务', index.taskNo, '状态', index.status, '流水', index.indexSerial);
  console.log('本企业行', index.rows.map(r => `${r.archiveNo} ${r.sheetRange}`));
  console.log('被过滤的别家企业行', index.blockedOtherSubjects);

  line('2. 取档请求（窗口关闭，受理待流水确认）');
  const request = await service.requestPull({
    mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
  });
  console.log('请求', request.requestId, '状态', request.state, '份数预占', request.quotaEntryId);

  line('3. 同档重复申请被拦截（门户仍可能回件，不耗第二份）');
  try {
    await service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
  } catch (error) {
    console.log('拦截', error.code, '—', error.message);
  }

  line('4. 流水对账：W5 受理，份数扣定（窗口关闭不回退）');
  await service.reconcileRequests();
  console.log('请求状态', request.state, '受理号', request.acceptanceNo);
  console.log('余额', JSON.stringify(service.balances()[0].perOffice.old));

  line('5. 门户出件，取档并核验扫描包');
  await clients.get('old').setScenario('released');
  await service.reconcileRequests();
  const inspection = await service.retrieveAndInspect({
    requestId: request.requestId,
    scanPaths: ['/scans/OD-5-2', '/scans/OD-5-3-mismatch'],
  });
  for (const result of inspection.verdict.allResults) {
    console.log(result.page.sheetRef, result.page.subject, '→', result.verdict, '—', result.note);
  }
  console.log('档案员核实队列', service.archivistHolds().map(h => h.holdId));
  // 档案员核实后解除扣留（真实流程中需档案员给出结论，这里演示处置路径）。
  service.resolveArchivistHold(request.requestId, {
    decision: '确认 B8 页不可用作 B3 联章依据，改向原册 FR-4/3 查补',
  });

  line('6. 迁移沿革与企业交接（查旧时点 t=20）');
  await clients.get('old').setScenario('handed');
  const cleanScan = await clients.get('old').fetchScan('/scans/OD-5-2');
  service.recordFromScan(cleanScan, { kind: 'ISSUE' });
  service.recordTransfer({ mandateId: 'MA-9', transfer: mandatesRecords[0].transfer, at: 23 });
  now = 20;
  const packet = await service.handover({
    mandateId: 'MA-9', subject: 'B3', mode: HANDOVER_MODE.HISTORICAL, at: 20,
  });
  console.log('交接包', packet.handoverId);
  for (const item of packet.items) {
    console.log(`  ${item.issueNo} ${item.office} 适用 ${item.appliesFrom}–${item.appliesUntil}`,
      `原件有效=${item.originalValidity} 代表当前=${item.representsCurrent}`);
  }
  console.log('迁出证据', packet.migrationEvidence);

  line('7. 授权撤回（t=36）：停止领取与原件下载，凭据保留');
  now = 36;
  try {
    await service.requestPull({
      mandateId: 'MA-9', office: 'old', subject: 'B3', folios: ['OD-5/2'],
    });
  } catch (error) {
    console.log('领取拦截', error.code);
  }
  console.log('下载策略', service.downloadPolicy({ mandateId: 'MA-9', folio: 'OD-5/2', at: 36 }));

  line('8. 审计流水（索引与取档各自独立可复核）');
  console.log('索引流水', service.audit.indexTrail().map(e => e.serial));
  console.log('取档流水', service.audit.pullTrail().map(e => `${e.kind}:${e.serial}`).slice(0, 6), '…');
  console.log('当前请求状态机', request.state === PULL_STATE.HANDED_OVER ? 'HANDED_OVER' : request.state);
} finally {
  await source.close();
}
