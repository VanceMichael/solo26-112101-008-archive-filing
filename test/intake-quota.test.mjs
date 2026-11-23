import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuotaLedger, QUOTA_ENTRY, QuotaLedgers } from '../intake/domain/quota-ledger.js';
import { PullLedger, PullRequest, PULL_STATE } from '../intake/domain/pull-request.js';
import { PendingPullError, QuotaError } from '../intake/domain/errors.js';

function ledger() {
  return new QuotaLedger({
    mandateId: 'MA-9', subject: 'B3',
    limits: { quota: 2, officeQuotas: { old: 2, new: 1 } },
  });
}

test('份数台账：提交预占、受理扣定、未受理释放', () => {
  const q = ledger();
  const id1 = q.reserve({ office: 'old', requestId: 'R1', at: 1 });
  assert.equal(q.balance().perOffice.old.available, 1);
  assert.equal(q.balance().total.available, 1);
  q.confirmAccepted({ requestId: 'R1', at: 2 });
  assert.equal(q.balance().perOffice.old.consumed, 1);

  const id2 = q.reserve({ office: 'old', requestId: 'R2', at: 3 });
  q.release({ requestId: 'R2', at: 4, reason: '明确未受理' });
  assert.equal(q.balance().perOffice.old.available, 1);
  assert.equal(q.balance().total.available, 1);
  assert.equal(q.entries.find(e => e.entryId === id2).state, QUOTA_ENTRY.RELEASED);
  assert.ok(id1);
});

test('份数台账：机关限额与总限额双重约束，新机关只有 1 份', () => {
  const q = ledger();
  q.reserve({ office: 'new', requestId: 'N1', at: 1 });
  assert.throws(() => q.reserve({ office: 'new', requestId: 'N2', at: 2 }), QuotaError);
  // 原机关仍有自己的独立额度
  assert.doesNotThrow(() => q.reserve({ office: 'old', requestId: 'O1', at: 3 }));
});

test('份数台账：总限额 2 被跨机关共享占满', () => {
  const q = ledger();
  q.reserve({ office: 'old', requestId: 'O1', at: 1 });
  q.reserve({ office: 'new', requestId: 'N1', at: 2 });
  assert.equal(q.balance().total.available, 0);
  assert.throws(() => q.reserve({ office: 'old', requestId: 'O2', at: 3 }), QuotaError);
});

test('份数台账：窗口关闭后迟到受理，余额充足时补扣', () => {
  const q = ledger();
  q.reserve({ office: 'old', requestId: 'O1', at: 1 });
  q.release({ requestId: 'O1', at: 5, reason: '窗口关闭' });
  assert.equal(q.balance().perOffice.old.available, 2);
  const entry = q.confirmAccepted({ requestId: 'O1', at: 8, late: true });
  assert.equal(entry.state, QUOTA_ENTRY.CONSUMED);
  assert.equal(entry.late, true);
  assert.equal(q.balance().perOffice.old.consumed, 1);
});

test('份数台账：迟到受理占掉留给另一机关的最后一份 -> 透支冲突并冻结新预占', () => {
  // 构造：总限额 2，机关 old 上限 1、new 上限 1；总额度跨机关共享。
  const q = new QuotaLedger({
    mandateId: 'MA-9', subject: 'B3',
    limits: { quota: 2, officeQuotas: { old: 1, new: 1 } },
  });
  // t=1 原机关一笔在途预占（额度尚空闲），t=2 窗口关闭、预占释放
  q.reserve({ office: 'old', requestId: 'O1', at: 1 });
  q.release({ requestId: 'O1', at: 2, reason: '窗口关闭' });
  // 释放出的份数按计划重新分配：原机关另一笔与新机关各受理一份，总额度占满
  q.reserve({ office: 'old', requestId: 'O0', at: 3 });
  q.confirmAccepted({ requestId: 'O0', at: 4 });
  q.reserve({ office: 'new', requestId: 'N1', at: 5 });
  q.confirmAccepted({ requestId: 'N1', at: 6 });
  assert.equal(q.balance().total.available, 0);
  assert.equal(q.balance().perOffice.old.available, 0);
  // 原机关 t=1 那笔的迟到受理到达：机关额度与总限额都已无份，记透支冲突
  const entry = q.confirmAccepted({ requestId: 'O1', at: 9, late: true });
  assert.equal(entry.state, QUOTA_ENTRY.OVERDRAWN);
  assert.throws(() => q.reserve({ office: 'old', requestId: 'O2', at: 10 }), QuotaError);
  assert.equal(q.balance().total.overdrawn, 1);
  // 新机关的那一份没有被回溯冲销
  assert.equal(q.balance().perOffice.new.consumed, 1);
});

test('取档登记册：门户仍可能回件时同档不能耗第二份', () => {
  const pl = new PullLedger();
  const mk = id => new PullRequest({
    mandateId: 'MA-9', subject: 'B3', office: 'old',
    folios: ['OD-5/2'], at: 1, indexSerial: 'IX-1', pullSerial: `PL-${id}`,
  });
  pl.add(mk(1));
  assert.throws(() => pl.add(mk(2)), PendingPullError);
  // 不同机关或不同企业不互斥
  const otherOffice = new PullRequest({
    mandateId: 'MA-9', subject: 'B3', office: 'new',
    folios: ['ND-9/1'], at: 1, indexSerial: 'IX-2', pullSerial: 'PL-3',
  });
  assert.doesNotThrow(() => pl.add(otherOffice));
});

test('取档登记册：终态后同档可重领，并给出可重领时点', () => {
  const pl = new PullLedger();
  const req = new PullRequest({
    mandateId: 'MA-9', subject: 'B3', office: 'old',
    folios: ['OD-5/2'], at: 1, indexSerial: 'IX-1', pullSerial: 'PL-1',
  });
  pl.add(req);
  req.transition(PULL_STATE.REJECTED, { at: 4, note: '未受理' });
  assert.equal(req.isTerminal, true);
  assert.equal(req.reRetrievableAt, 4);
  const again = new PullRequest({
    mandateId: 'MA-9', subject: 'B3', office: 'old',
    folios: ['OD-5/2'], at: 5, indexSerial: 'IX-2', pullSerial: 'PL-2',
  });
  assert.doesNotThrow(() => pl.add(again));
});

test('取档状态机：已受理一次扣一份，窗口关闭不回退受理', () => {
  const req = new PullRequest({
    mandateId: 'MA-9', subject: 'B3', office: 'old',
    folios: ['OD-5/2'], at: 1, indexSerial: 'IX-1', pullSerial: 'PL-1',
  });
  req.transition(PULL_STATE.ACCEPTED, { at: 2, acceptanceNo: 'W5' });
  assert.equal(req.quotaCharged, true);
  req.transition(PULL_STATE.AVAILABLE, { at: 3 });
  req.transition(PULL_STATE.RETRIEVED, { at: 4, receiptNo: 'RC-1' });
  assert.throws(
    () => req.transition(PULL_STATE.SUBMITTED, { at: 5 }),
    error => error.code === 'ILLEGAL_STATE',
  );
  // 受理历史不可篡改：状态轨迹完整保留
  assert.deepEqual(req.history.map(h => h.state),
    ['SUBMITTED', 'ACCEPTED', 'AVAILABLE', 'RETRIEVED']);
});

test('多委托台账：一家企业透支不影响另一家继续查找', () => {
  const ledgers = new QuotaLedgers();
  const fakeMandate = (id, subject, quota, officeQuotas) => ({
    id, subject,
    revisions: [{ revision: 1, quota, officeQuotas }],
  });
  const b3 = ledgers.forMandate(fakeMandate('MA-9', 'B3', 1, { old: 1 }));
  b3.reserve({ office: 'old', requestId: 'X', at: 1 });
  b3.release({ requestId: 'X', at: 2, reason: '关闭' });
  b3.confirmAccepted({ requestId: 'X', at: 3, late: true }); // 透支
  assert.throws(() => b3.reserve({ office: 'old', requestId: 'Y', at: 4 }), QuotaError);

  const b8 = ledgers.forMandate(fakeMandate('MA-12', 'B8', 1, { old: 1 }));
  assert.doesNotThrow(() => b8.reserve({ office: 'old', requestId: 'Z', at: 5 }));
});
