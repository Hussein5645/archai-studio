import type { Page } from '@playwright/test';

/** Synthetic account; no credentials or requests reach the deployed service. */
export async function signInFixture(page: Page) {
  await page.route('https://archai-cloud.mklkoklpp.workers.dev/**', route => route.fulfill({ json: {
    token: 'browser-fixture-only', user: { id: 'fixture', email: 'fixture@example.invalid', name: 'Fixture' }, libraryToken: 'fixture', projects: [],
  } }));
  await page.evaluate(async () => { await window.__archai!.account.signIn('fixture@example.invalid', 'fixture-password'); });
}
