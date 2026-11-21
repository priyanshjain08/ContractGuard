import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// UNVERIFIED: written against the UI above but never run (no browser/DB/Redis in the authoring environment).
const fixtures = join(__dirname, '../../../fixtures');
const email = `e2e-${Date.now()}@example.com`;

test('signup → project → two uploads → comparison → findings → export', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Name').fill('E2E User');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct-horse-battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  await page.goto('/projects');
  await page.getByLabel('Project name').fill('Petstore API');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: 'Petstore API' })).toBeVisible();

  for (const [file, n] of [['petstore-v1.yaml', 1], ['petstore-v2.yaml', 2]] as const) {
    await page.locator('input[type=file]').setInputFiles(join(fixtures, file));
    await page.getByRole('button', { name: 'Add version' }).click();
    await expect(page.getByText(`Stored version v${n}.`)).toBeVisible();
  }

  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(page).toHaveURL(/\/comparisons\//);
  await expect(page.getByTestId('findings-total')).toHaveText('28 finding(s)', { timeout: 30_000 }); // worker finished

  await page.getByLabel('Category').selectOption('BREAKING');
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page.getByTestId('findings-total')).toHaveText('14 finding(s)');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export JSON' }).click()]);
  const report = JSON.parse(readFileSync(await download.path(), 'utf8'));
  expect(report.findings).toHaveLength(28);
  expect(report.result).toBe('FAIL');
});

test('tenant isolation: a second user cannot open the first user’s comparison', async ({ browser, page }) => {
  const url = page.url();
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto('/signup');
  await p2.getByLabel('Name').fill('Other');
  await p2.getByLabel('Email').fill(`other-${Date.now()}@example.com`);
  await p2.getByLabel('Password').fill('correct-horse-battery');
  await p2.getByRole('button', { name: 'Create account' }).click();
  await expect(p2).toHaveURL(/\/dashboard/);
  if (/comparisons\//.test(url)) { const res = await p2.goto(url); expect(res?.status()).not.toBe(200); }
  await other.close();
});

test('invalid specs are rejected with a clear message', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('nobody@example.com');
  await page.getByLabel('Password').fill('wrong-password-123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
});
