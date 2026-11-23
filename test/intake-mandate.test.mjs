import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { MandateRegistry } from '../intake/domain/mandate.js';
import { AuthorizationError, FolioNotSeparableError } from '../intake/domain/errors.js';

const records = JSON.parse(await readFile(new URL('../data/mandates.json', import.meta.url)));
const registry = MandateRegistry.fromRecords(records);

test('授权批单：收窄修订不抹掉基础批单对承接机关的授权', () => {
  const mandate = registry.get('MA-9');
  // t=26：rev2 仍有效，但基础 rev1 覆盖承接机关 ND-9/1
  assert.equal(mandate.revisionAt(26).revision, 1);
  mandate.authorize({ subject: 'B3', office: 'new', folio: 'ND-9/1', at: 26 });
  // 原机关档页同样可领
  mandate.authorize({ subject: 'B3', office: 'old', folio: 'OD-5/2', at: 26 });
});

test('授权批单：撤回时点之后未交接页不得领取', () => {
  const mandate = registry.get('MA-9');
  // t=35 起 rev2 撤回；t=36 基础批单仍在有效期（until 41），但撤回标记已生效
  assert.equal(mandate.isRevoked, true);
  assert.equal(mandate.revokedAt, 35);
  assert.throws(
    () => mandate.authorize({ subject: 'B3', office: 'old', folio: 'OD-5/2', at: 36 }),
    error => error instanceof AuthorizationError && error.code === 'AUTHORIZATION_DENIED',
  );
});

test('授权批单：有效期外无授权', () => {
  const mandate = registry.get('MA-9');
  assert.equal(mandate.revisionAt(42), null);
  assert.throws(() => mandate.authorize({
    subject: 'B3', office: 'old', folio: 'OD-5/2', at: 42,
  }), AuthorizationError);
});

test('授权批单：企业不匹配直接拒绝', () => {
  assert.throws(() => registry.get('MA-9').authorize({
    subject: 'B8', office: 'old', folio: 'OD-5/2', at: 20,
  }), AuthorizationError);
});

test('授权批单：门户未开放单独调取的页拒绝领取', () => {
  // 授权含 OD-5/3，但门户白名单只给 OD-5/2
  assert.throws(() => registry.authorizeSeparable({
    mandateId: 'MA-9', subject: 'B3', office: 'old', folio: 'OD-5/3', at: 20,
    separableFolios: ['OD-5/2'],
  }), FolioNotSeparableError);
  // 白名单内可领
  const { revision } = registry.authorizeSeparable({
    mandateId: 'MA-9', subject: 'B3', office: 'old', folio: 'OD-5/2', at: 20,
    separableFolios: ['OD-5/2'],
  });
  assert.equal(revision.id, 'MA-9');
});

test('授权批单：不同企业批单独立，B8 不能用 B3 的批单', () => {
  const mandates = registry.forSubject('B8', 20);
  assert.deepEqual(mandates.map(m => m.id), ['MA-12']);
  assert.throws(() => registry.get('MA-12').authorize({
    subject: 'B3', office: 'old', folio: 'OD-5/2', at: 20,
  }), AuthorizationError);
});

test('撤回后的下载策略：已交接页留凭据但不再提供原件下载', () => {
  const fakeHandoverLedger = { wasHandedOver: (id, folio) => id === 'MA-9' && folio === 'OD-5/2' };
  const handed = registry.downloadPermitted({
    mandateId: 'MA-9', folio: 'OD-5/2', handoverLedger: fakeHandoverLedger, at: 36,
  });
  assert.equal(handed.permitted, false);
  assert.equal(handed.evidenceRetained, true);
  assert.match(handed.reason, /交接凭据留存/);
  const notHanded = registry.downloadPermitted({
    mandateId: 'MA-9', folio: 'OD-5/3', handoverLedger: fakeHandoverLedger, at: 36,
  });
  assert.equal(notHanded.permitted, false);
  assert.match(notHanded.reason, /未交接页/);
  // 撤回前正常下载
  assert.equal(registry.downloadPermitted({
    mandateId: 'MA-9', folio: 'OD-5/2', handoverLedger: fakeHandoverLedger, at: 30,
  }).permitted, true);
});
