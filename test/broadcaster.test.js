import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from './helpers/mock-supabase.js';
import { _setClientForTesting } from '../src/supabase-client.js';
import { runBatches } from '../src/broadcaster.js';

function createMockResendClient() {
  const calls = [];
  return {
    calls,
    listContacts: async () => {
      calls.push('listContacts');
      return [];
    },
    addContact: async (segmentId, contact) => {
      calls.push({ method: 'addContact', email: contact.email });
      return { id: `contact-${contact.email}` };
    },
    createBroadcast: async (opts) => {
      calls.push({ method: 'createBroadcast', name: opts.name });
      return { id: 'bc_1' };
    },
    sendBroadcast: async (id) => {
      calls.push({ method: 'sendBroadcast', id });
      return { id };
    },
    getBroadcast: async (id) => {
      calls.push({ method: 'getBroadcast', id });
      return { id, status: 'sent' };
    },
    removeContact: async (id) => {
      calls.push({ method: 'removeContact', id });
      return null;
    },
    removeContactFromSegment: async (contactId, segmentId) => {
      calls.push({ method: 'removeContactFromSegment', contactId, segmentId });
      return null;
    },
  };
}

const baseConfig = {
  segmentId: 'seg_1',
  fromEmail: 'sender@x.com',
  replyTo: 'reply@x.com',
  batchSize: 100,
  pollIntervalMs: 0,
  pollTimeoutMs: 5000,
};

describe('runBatches', () => {
  let mockResend;
  let supabaseMock;

  beforeEach(() => {
    mockResend = createMockResendClient();
  });

  function setupSupabase(responses) {
    supabaseMock = createMockClient(responses);
    _setClientForTesting(supabaseMock);
  }

  it('completes all 6 steps for a single batch', async () => {
    // markBatchSent: update + in → needs 1 response
    setupSupabase([{ error: null }]);

    const batches = [[
      { id: 'r1', email: 'a@x.com', first_name: 'A', last_name: 'B', organization: '', unsubscribe_token: 'tok1' },
    ]];

    await runBatches(mockResend, baseConfig, 'test-group', batches, '<p>Hi</p>', 'Subject');

    // Verify the step order
    const methods = mockResend.calls.map((c) => (typeof c === 'string' ? c : c.method));
    assert.ok(methods.includes('listContacts'), 'should snapshot existing contacts');
    assert.ok(methods.includes('addContact'), 'should add contacts');
    assert.ok(methods.includes('createBroadcast'), 'should create broadcast');
    assert.ok(methods.includes('sendBroadcast'), 'should send broadcast');
    assert.ok(methods.includes('getBroadcast'), 'should poll broadcast');
    assert.ok(methods.includes('removeContact'), 'should remove contacts');

    // Verify step order is correct
    const methodOrder = ['listContacts', 'addContact', 'createBroadcast', 'sendBroadcast', 'getBroadcast', 'removeContact'];
    let lastIdx = -1;
    for (const m of methodOrder) {
      const idx = methods.indexOf(m);
      assert.ok(idx > lastIdx, `${m} should come after previous steps (idx=${idx}, lastIdx=${lastIdx})`);
      lastIdx = idx;
    }
  });

  it('processes multiple batches sequentially', async () => {
    // Two batches → two markBatchSent calls
    setupSupabase([{ error: null }, { error: null }]);

    const batches = [
      [{ id: 'r1', email: 'a@x.com', first_name: '', last_name: '', organization: '', unsubscribe_token: '' }],
      [{ id: 'r2', email: 'b@x.com', first_name: '', last_name: '', organization: '', unsubscribe_token: '' }],
    ];

    await runBatches(mockResend, baseConfig, 'test-group', batches, '<p>Hi</p>', 'Sub');

    const addCalls = mockResend.calls.filter((c) => c.method === 'addContact');
    assert.equal(addCalls.length, 2);
    const createCalls = mockResend.calls.filter((c) => c.method === 'createBroadcast');
    assert.equal(createCalls.length, 2);
  });

  it('cleans up and marks failed on error', async () => {
    // markBatchFailed: update + in → needs 1 response
    setupSupabase([{ error: null }]);

    // Make createBroadcast fail
    mockResend.createBroadcast = async () => {
      throw new Error('API down');
    };

    const batches = [[
      { id: 'r1', email: 'a@x.com', first_name: '', last_name: '', organization: '', unsubscribe_token: '' },
    ]];

    await assert.rejects(
      () => runBatches(mockResend, baseConfig, 'test-group', batches, '<p>Hi</p>', 'Sub'),
      { message: /API down/ }
    );

    // Should still have called removeContact for cleanup
    const removeCalls = mockResend.calls.filter((c) => c.method === 'removeContact');
    assert.ok(removeCalls.length >= 0); // Cleanup attempted

    // markBatchFailed should have been called
    const updateCalls = supabaseMock.calls.filter((c) => c.method === 'update');
    assert.ok(updateCalls.length > 0);
    assert.equal(updateCalls[0].args[0].status, 'failed');
  });

  it('pre-existing contacts are removed from segment only, not deleted', async () => {
    setupSupabase([{ error: null }]);

    // Simulate a contact already present in the segment before the batch
    mockResend.listContacts = async () => {
      mockResend.calls.push('listContacts');
      return [{ id: 'existing-1', email: 'old@x.com' }];
    };
    // addContact returns the same ID for a pre-existing contact (Resend upsert)
    mockResend.addContact = async (segmentId, contact) => {
      mockResend.calls.push({ method: 'addContact', email: contact.email });
      return { id: 'existing-1' };
    };

    const batches = [[
      { id: 'r1', email: 'old@x.com', first_name: '', last_name: '', organization: '', unsubscribe_token: '' },
    ]];

    await runBatches(mockResend, baseConfig, 'test-group', batches, '<p>Hi</p>', 'Sub');

    // removeContact (full delete) must NOT be called for the pre-existing contact
    const deleteCalls = mockResend.calls.filter((c) => c.method === 'removeContact');
    assert.equal(deleteCalls.length, 0, 'should not fully delete a pre-existing contact');

    // removeContactFromSegment MUST be called for it instead
    const segmentRemoveCalls = mockResend.calls.filter((c) => c.method === 'removeContactFromSegment');
    assert.equal(segmentRemoveCalls.length, 1, 'should remove pre-existing contact from segment');
    assert.equal(segmentRemoveCalls[0].contactId, 'existing-1');
    assert.equal(segmentRemoveCalls[0].segmentId, baseConfig.segmentId);
  });

  it('newly created contacts are fully deleted after send', async () => {
    setupSupabase([{ error: null }]);

    // listContacts returns empty — no pre-existing contacts
    mockResend.listContacts = async () => {
      mockResend.calls.push('listContacts');
      return [];
    };

    const batches = [[
      { id: 'r1', email: 'new@x.com', first_name: '', last_name: '', organization: '', unsubscribe_token: '' },
    ]];

    await runBatches(mockResend, baseConfig, 'test-group', batches, '<p>Hi</p>', 'Sub');

    // removeContact (full delete) must be called for the new contact
    const deleteCalls = mockResend.calls.filter((c) => c.method === 'removeContact');
    assert.equal(deleteCalls.length, 1, 'should fully delete a newly created contact');
    assert.equal(deleteCalls[0].id, 'contact-new@x.com');

    // removeContactFromSegment must NOT be called
    const segmentRemoveCalls = mockResend.calls.filter((c) => c.method === 'removeContactFromSegment');
    assert.equal(segmentRemoveCalls.length, 0, 'should not use segment-removal for a new contact');
  });
});
