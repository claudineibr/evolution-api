import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import axios from 'axios';
import { validateOfficialCredentials } from '../src/api/integrations/channel/meta/official-credentials';

const config = {
  ENCRYPTION_KEY: 'ab'.repeat(32),
  URL: 'https://graph.facebook.com',
  VERSION: 'v23.0',
  LANGUAGE: 'pt_BR',
};
const app = { app_id: '100', app_secret: 'test-secret', verify_token: 'verify' };
const credentials = { token: 'existing-token', waba_id: '300', phone_number_id: '200' };

test('refuses a valid token belonging to another Meta app', async () => {
  const mocked = mock.method(axios, 'get', async () => ({ data: { data: { is_valid: true, app_id: '999' } } }));
  try {
    await assert.rejects(validateOfficialCredentials(config, credentials, app), /aplicativo Meta/);
    assert.equal(mocked.mock.callCount(), 1);
  } finally {
    mocked.mock.restore();
  }
});

test('selects the requested number from later pages instead of the first number', async () => {
  const mocked = mock.method(axios, 'get', async (url: string, options: any) => {
    if (url.endsWith('debug_token'))
      return {
        data: {
          data: {
            is_valid: true,
            app_id: '100',
            scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
          },
        },
      };
    if (url.endsWith('message_templates')) return { data: { data: [] } };
    if (options.params.after) return { data: { data: [{ id: '200', display_phone_number: '5511999999999' }] } };
    return { data: { data: [{ id: '111' }], paging: { next: 'next', cursors: { after: 'cursor' } } } };
  });
  try {
    assert.equal((await validateOfficialCredentials(config, credentials, app)).id, '200');
    assert.equal(mocked.mock.callCount(), 4);
  } finally {
    mocked.mock.restore();
  }
});
