import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import {
  encryptMetaSecret,
  decryptMetaSecret,
  equalMetaToken,
  MetaAppService,
} from '../src/api/integrations/channel/meta/meta-app.service';
import { MetaController } from '../src/api/integrations/channel/meta/meta.controller';
import { verifyMetaSignature } from '../src/api/integrations/channel/meta/meta-signature';

const key = 'ab'.repeat(32);
const config: any = { ENCRYPTION_KEY: key };

test('encrypted credentials cannot be decrypted with another key or after tampering', () => {
  const encrypted = encryptMetaSecret('secret-value', key);
  assert.equal(decryptMetaSecret(encrypted, key), 'secret-value');
  assert.notEqual(encrypted, encryptMetaSecret('secret-value', key));
  assert.throws(() => decryptMetaSecret(encrypted, 'cd'.repeat(32)));
  const parts = encrypted.split('.');
  parts[2] = Buffer.from('tampered-value').toString('base64');
  assert.throws(() => decryptMetaSecret(parts.join('.'), key));
  assert.throws(() => encryptMetaSecret('secret', ''));
});

test('verification and event signatures belong to the selected app only', () => {
  const body = Buffer.from('{"entry":[]}');
  const signature = 'sha256=' + createHmac('sha256', 'app-a-secret').update(body).digest('hex');
  assert.ok(verifyMetaSignature('app-a-secret', body, signature));
  assert.equal(verifyMetaSignature('app-b-secret', body, signature), false);
  assert.ok(equalMetaToken('verify-a', 'verify-a'));
  assert.equal(equalMetaToken('verify-b', 'verify-a'), false);
  assert.equal(equalMetaToken(['verify-a'], 'verify-a'), false);
});

test('missing app ID never becomes an unscoped Prisma lookup', async () => {
  let queried = false;
  const service = new MetaAppService(
    {
      metaApp: {
        findFirst: () => {
          queried = true;
        },
      },
    } as any,
    config,
    {} as any,
  );
  await assert.rejects(service.require(undefined), /aplicativo Meta/);
  assert.equal(queried, false);
});

test('duplicate payloads from different apps have separate durable inbox keys', async () => {
  const records: any[] = [];
  const repository: any = { metaWebhookInbox: { upsert: async (args: any) => records.push(args) } };
  const controller = new MetaController(repository, {} as any);
  const payload = { object: 'whatsapp_business_account', entry: [] };
  await controller.enqueueWebhook(payload, 'app-a');
  await controller.enqueueWebhook(payload, 'app-a');
  await controller.enqueueWebhook(payload, 'app-b');
  assert.equal(records[0].where.id, records[1].where.id);
  assert.notEqual(records[0].where.id, records[2].where.id);
  assert.equal(records[2].create.metaAppId, 'app-b');
});

test('grouped messages, statuses and WABA template events stay inside the app', async () => {
  const delivered: any[] = [];
  const scopes: any[] = [];
  const repository: any = {
    metaApp: { findFirst: async () => ({ id: 'app-a' }) },
    instance: {
      findMany: async ({ where }: any) => {
        scopes.push(where);
        if (where.metaAppId !== 'app-a' || where.businessId !== 'waba-a') return [];
        return [{ id: 'number-a', name: 'instance-a' }];
      },
    },
    message: { findFirst: async () => null },
  };
  const channel = {
    connectToWhatsapp: async (event: any) => delivered.push(event),
    sendDataWebhook: async (...event: any[]) => delivered.push(event),
  };
  const controller = new MetaController(repository, { waInstances: { 'instance-a': channel } } as any);
  await controller.receiveWebhook(
    {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-b',
          changes: [
            {
              field: 'messages',
              value: { metadata: { phone_number_id: 'phone-b' }, messages: [{ id: 'foreign', from: '123' }] },
            },
          ],
        },
        {
          id: 'waba-a',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'phone-a' },
                messages: [
                  { id: 'first', from: '123' },
                  { id: 'second', from: '456' },
                ],
                statuses: [{ id: 'sent', status: 'read', recipient_id: '123' }],
              },
            },
            { field: 'message_template_status_update', value: { message_template_id: 'template-a' } },
          ],
        },
      ],
    },
    'app-a',
  );
  assert.equal(delivered.length, 4);
  assert.ok(scopes.every((scope) => scope.metaAppId === 'app-a'));
  assert.equal(delivered[0].entry[0].changes[0].value.messages[0].id, 'first');
  assert.equal(delivered[1].entry[0].changes[0].value.messages[0].id, 'second');
});

test('deleted app never delivers previously queued messages', async () => {
  const repository: any = { metaApp: { findFirst: async () => null } };
  const controller = new MetaController(repository, {} as any);
  await controller.receiveWebhook({ object: 'whatsapp_business_account', entry: [{ id: 'waba-a' }] }, 'deleted-app');
});

test('legacy inbox rows remain quarantined and a queued event resumes with its app', async () => {
  const scopes: any[] = [];
  const completed: string[] = [];
  const repository: any = {
    metaWebhookInbox: {
      findMany: async (query: any) => {
        scopes.push(query.where);
        return [{ id: 'queued', metaAppId: 'app-a', attempts: 0, payload: {} }];
      },
      updateMany: async () => ({ count: 1 }),
      update: async (query: any) => completed.push(query.where.id),
      deleteMany: async () => ({}),
    },
  };
  const controller = new MetaController(repository, {} as any);
  const received: string[] = [];
  controller.receiveWebhook = async (_data, appId) => {
    received.push(appId);
  };
  await controller.drainWebhookInbox();
  assert.deepEqual(scopes[0].metaAppId, { not: null });
  assert.deepEqual(received, ['app-a']);
  assert.deepEqual(completed, ['queued']);
});
