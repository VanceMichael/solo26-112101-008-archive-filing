import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startSources } from '../sources/server.mjs';

test('Chromium 可通过日常操作使用演练来源', async () => {
  const source = await startSources();
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ acceptDownloads: true });
    const tab = await context.newPage();

    await tab.goto(source.url + '/archive');
    await tab.getByRole('textbox', { name: '企业短码' }).fill('B3');
    await tab.getByRole('button', { name: '查询档号' }).click();
    assert.equal(await tab.getByRole('heading', { name: '原机关查询 Q7' }).count(), 1);
    await tab.getByRole('textbox', { name: '企业', exact: true }).fill('B3');
    await tab.getByRole('textbox', { name: '档页' }).fill('OD-5/2');
    await tab.getByRole('button', { name: '请求领件' }).click();
    await tab.getByRole('link', { name: '领件流水' }).click();
    assert.equal(await tab.getByText('old W5 OD-5/2 已受理', { exact: false }).count(), 1);
    await context.request.post(source.url + '/scenario/released');
    await tab.reload();
    await tab.getByRole('link', { name: '原册第2页' }).click();
    assert.equal(await tab.getByText('联章待核 原册第3页').count(), 1);
    await context.request.post(source.url + '/scenario/handed');
    await tab.goto(source.url + '/archive/requests');
    await tab.getByRole('link', { name: '重打件' }).click();
    assert.equal(await tab.getByText('明确替代签发号 K1', { exact: false }).count(), 1);
  } finally {
    await browser?.close();
    await source.close();
  }
});
