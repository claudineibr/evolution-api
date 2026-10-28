import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifyMetaSignature } from '../src/api/integrations/channel/meta/meta-signature';

test('Meta signature authenticates the original bytes only', () => {
  const body = Buffer.from('{"entry":[]}');
  const signature = `sha256=${createHmac('sha256', 'test-secret').update(body).digest('hex')}`;
  assert.equal(verifyMetaSignature('test-secret', body, signature), true);
  assert.equal(verifyMetaSignature('wrong', body, signature), false);
  assert.equal(verifyMetaSignature('test-secret', Buffer.from('{ "entry": [] }'), signature), false);
  assert.equal(verifyMetaSignature('', body, signature), false);
  assert.equal(verifyMetaSignature('test-secret', body, 'sha256=bad'), false);
});
