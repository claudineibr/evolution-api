import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MetaController } from '../src/api/integrations/channel/meta/meta.controller';

function fixture() {
  const queries: any[] = [];
  const delivered: any[] = [];
  const updates: any[] = [];
  const instance = { id: 'official', name: 'tenant-a', number: '222', businessId: '111', metaAppId: 'app-a' };
  const legacy = { stateConnection: { state: 'open' } };
  const channel = {
    stateConnection: { state: 'open' },
    sendDataWebhook: async (event: any, data: any) => { delivered.push({ event, data }); },
    connectToWhatsapp: async () => { throw new Error('Coexistence must not dispatch the live bot'); },
  };
  const repository: any = {
    metaApp: { findFirst: async () => ({ id: 'app-a' }) },
    instance: {
      findMany: async (query: any) => {
        queries.push(query.where);
        return query.where.metaAppId === 'app-a' && query.where.businessId === '111' ? [instance] : [];
      },
      update: async (query: any) => { updates.push(query); },
    },
  };
  const monitor: any = { waInstances: { 'tenant-a': channel, 'legacy-qr': legacy } };
  return { controller: new MetaController(repository, monitor), queries, delivered, updates, channel, legacy };
}

function payload(field: string, value: any, waba = '111') {
  return { object: 'whatsapp_business_account', entry: [{ id: waba, changes: [{ field, value }] }] };
}

test('mobile echoes stay scoped to app, WABA and phone and bypass the bot', async () => {
  const f = fixture();
  const value = { metadata: { phone_number_id: '222' }, message_echoes: [{ id: 'mobile', to: '5511999990000' }] };
  await f.controller.receiveWebhook(payload('smb_message_echoes', value), 'app-a');
  assert.equal(f.delivered.length, 1);
  assert.deepEqual(f.delivered[0].data.coexistence_event, { field: 'smb_message_echoes', value, waba_id: '111' });
  assert.equal(f.queries[0].number, '222');
  assert.equal(f.queries[0].metaAppId, 'app-a');
  await f.controller.receiveWebhook(payload('smb_message_echoes', value, 'foreign-waba'), 'app-a');
  assert.equal(f.delivered.length, 1);
});

test('history is sent in bounded batches and final progress belongs to the last batch', async () => {
  const f = fixture();
  const messages = Array.from({ length: 51 }, (_, i) => ({ id: `history-${i}`, type: 'text' }));
  await f.controller.receiveWebhook(payload('history', {
    metadata: { phone_number_id: '222' },
    history: [{ metadata: { progress: 100 }, threads: [{ id: '5511999990000', messages }] }],
  }), 'app-a');
  assert.deepEqual(f.delivered.map(item => item.data.coexistence_event.value.history[0].threads.length), [25, 25, 1]);
  assert.deepEqual(f.delivered.map(item => item.data.coexistence_event.value.history[0].metadata.progress),
    [undefined, undefined, 100]);
});

test('declined history is forwarded without fabricating messages', async () => {
  const f = fixture();
  const value = { metadata: { phone_number_id: '222' }, history: [{ errors: [{ code: 2593109 }] }] };
  await f.controller.receiveWebhook(payload('history', value), 'app-a');
  assert.equal(f.delivered[0].data.coexistence_event.value.history[0].errors[0].code, 2593109);
});

test('contact synchronization is bounded and never dispatches live messages', async () => {
  const f = fixture();
  await f.controller.receiveWebhook(payload('smb_app_state_sync', {
    metadata: { phone_number_id: '222' }, state_sync: Array.from({ length: 201 }, (_, id) => ({ contact: { id } })),
  }), 'app-a');
  assert.deepEqual(f.delivered.map(item => item.data.coexistence_event.value.state_sync.length), [100, 100, 1]);
});

test('removing one partner does not close a QR connection or another WABA', async () => {
  const f = fixture();
  await f.controller.receiveWebhook(payload('account_update', { event: 'PARTNER_REMOVED' }), 'app-a');
  assert.equal(f.updates.length, 1);
  assert.equal(f.updates[0].where.id, 'official');
  assert.equal(f.channel.stateConnection.state, 'close');
  assert.equal(f.legacy.stateConnection.state, 'open');
  await f.controller.receiveWebhook(payload('account_update', { event: 'PARTNER_REMOVED' }, 'foreign-waba'), 'app-a');
  assert.equal(f.updates.length, 1);
});
