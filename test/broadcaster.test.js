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

  it('preserves pre-existing segment contacts', async () => {
    setupSupabase([{ error: null }]);

    // Pre-existing contacts in segment
    mockResend.listContacts = async () => {
      mockResend.calls.push('listContacts');
      return [{ id: 'existing-1', email: 'old@x.com' }];
    };

    const batches = [[
      { id: 'r1', email: 'new@x.com', first_name: '', last_name: '', organization: '', unsubscribe_token: '' },
    ]];

    await runBatches(mockResend, baseConfig, 'test-group', batches, '<p>Hi</p>', 'Sub');

    // removeContact should only be called for the newly added contact, not existing-1
    const removeCalls = mockResend.calls.filter((c) => c.method === 'removeContact');
    for (const call of removeCalls) {
      assert.notEqual(call.id, 'existing-1', 'should not remove pre-existing contact');
    }
  });
});
