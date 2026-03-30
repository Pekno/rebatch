import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from './helpers/mock-supabase.js';
import {
  _setClientForTesting,
  importContacts,
  groupExists,
  deleteGroupRecipients,
  getPendingRecipients,
  getGroupStats,
  markBatchSent,
  markBatchFailed,
} from '../src/supabase-client.js';

describe('supabase-client', () => {
  let mockClient;

  function setup(responses) {
    mockClient = createMockClient(responses);
    _setClientForTesting(mockClient);
  }

  describe('importContacts', () => {
    it('inserts new contacts', async () => {
      setup([
        // select existing → not found
        { data: null, error: null },
        // insert → success
        { error: null },
      ]);

      const contacts = [{ email: 'a@x.com', firstName: 'A', lastName: 'B', organization: 'C' }];
      const result = await importContacts(contacts, 'test-group', new Set(), () => {});

      assert.equal(result.inserted, 1);
      assert.equal(result.updated, 0);
      assert.equal(result.skipped, 0);

      // Verify insert was called with correct data
      const insertCall = mockClient.calls.find((c) => c.method === 'insert');
      assert.ok(insertCall);
      assert.equal(insertCall.args[0].email, 'a@x.com');
      assert.deepStrictEqual(insertCall.args[0].group_names, ['test-group']);
      assert.equal(insertCall.args[0].status, 'pending');
    });

    it('updates existing contact without group', async () => {
      setup([
        // select existing → found without this group
        { data: { id: 'id-1', first_name: 'A', last_name: 'B', organization: 'C', group_names: ['other'], status: 'pending' }, error: null },
        // update → success
        { error: null },
      ]);

      const contacts = [{ email: 'a@x.com', firstName: 'A', lastName: 'B', organization: 'C' }];
      const result = await importContacts(contacts, 'new-group', new Set(), () => {});

      assert.equal(result.updated, 1);

      const updateCall = mockClient.calls.find((c) => c.method === 'update');
      assert.ok(updateCall);
      assert.deepStrictEqual(updateCall.args[0].group_names, ['other', 'new-group']);
    });

    it('marks contacts already in segment as already_contacted', async () => {
      setup([
        // select existing → not found
        { data: null, error: null },
        // insert → success
        { error: null },
      ]);

      const contacts = [{ email: 'a@x.com', firstName: '', lastName: '', organization: '' }];
      const segmentEmails = new Set(['a@x.com']);
      const result = await importContacts(contacts, 'test-group', segmentEmails, () => {});

      assert.equal(result.alreadyContacted, 1);
      assert.equal(result.inserted, 0);

      const insertCall = mockClient.calls.find((c) => c.method === 'insert');
      assert.equal(insertCall.args[0].status, 'already_contacted');
    });

    it('skips contacts already in group', async () => {
      setup([
        // select existing → found with this group already
        { data: { id: 'id-1', first_name: 'A', last_name: 'B', organization: 'C', group_names: ['test-group'], status: 'pending' }, error: null },
      ]);

      const contacts = [{ email: 'a@x.com', firstName: 'A', lastName: 'B', organization: 'C' }];
      const result = await importContacts(contacts, 'test-group', new Set(), () => {});

      assert.equal(result.skipped, 1);
    });

    it('calls onProgress for each contact', async () => {
      setup([
        { data: null, error: null }, { error: null },
        { data: null, error: null }, { error: null },
      ]);

      const progressCalls = [];
      const contacts = [
        { email: 'a@x.com', firstName: '', lastName: '', organization: '' },
        { email: 'b@x.com', firstName: '', lastName: '', organization: '' },
      ];
      await importContacts(contacts, 'g', new Set(), (n) => progressCalls.push(n));

      assert.deepStrictEqual(progressCalls, [1, 2]);
    });
  });

  describe('groupExists', () => {
    it('returns true when count > 0', async () => {
      setup([{ count: 5, error: null }]);
      const result = await groupExists('test');
      assert.equal(result, true);
    });

    it('returns false when count is 0', async () => {
      setup([{ count: 0, error: null }]);
      const result = await groupExists('test');
      assert.equal(result, false);
    });

    it('throws on error', async () => {
      setup([{ count: null, error: { message: 'db error' } }]);
      await assert.rejects(() => groupExists('test'), { message: /Failed to check group/ });
    });
  });

  describe('deleteGroupRecipients', () => {
    it('deletes single-group recipients', async () => {
      setup([
        // First page of recipients
        { data: [{ id: 'id-1', group_names: ['test'] }], error: null },
        // Second page (empty = end of pagination)
        { data: [], error: null },
        // delete result
        { error: null },
      ]);

      const result = await deleteGroupRecipients('test');

      assert.equal(result.deleted, 1);
      assert.equal(result.ungrouped, 0);
      assert.equal(result.total, 1);
    });

    it('ungroupes multi-group recipients', async () => {
      setup([
        { data: [{ id: 'id-1', group_names: ['test', 'other'] }], error: null },
        { data: [], error: null },
        // update (ungroup)
        { error: null },
      ]);

      const result = await deleteGroupRecipients('test');

      assert.equal(result.deleted, 0);
      assert.equal(result.ungrouped, 1);

      const updateCall = mockClient.calls.find((c) => c.method === 'update');
      assert.deepStrictEqual(updateCall.args[0].group_names, ['other']);
    });
  });

  describe('getPendingRecipients', () => {
    it('returns pending recipients', async () => {
      const recipients = [{ id: 'id-1', email: 'a@x.com' }];
      setup([{ data: recipients, error: null }]);

      const result = await getPendingRecipients('test');

      assert.deepStrictEqual(result, recipients);
    });

    it('throws on error', async () => {
      setup([{ data: null, error: { message: 'query failed' } }]);
      await assert.rejects(() => getPendingRecipients('test'), { message: /Failed to query/ });
    });
  });

  describe('getGroupStats', () => {
    it('returns all counts', async () => {
      setup([
        { count: 10 }, // total
        { count: 3 },  // pending
        { count: 1 },  // failed
        { count: 5 },  // sent
        { count: 0 },  // alreadyContacted
        { count: 1 },  // unsubscribed
      ]);

      const stats = await getGroupStats('test');

      assert.deepStrictEqual(stats, {
        total: 10,
        pending: 3,
        failed: 1,
        sent: 5,
        alreadyContacted: 0,
        unsubscribed: 1,
      });
    });
  });

  describe('markBatchSent', () => {
    it('updates status to sent', async () => {
      setup([{ error: null }]);
      await markBatchSent(['id-1', 'id-2']);

      const updateCall = mockClient.calls.find((c) => c.method === 'update');
      assert.equal(updateCall.args[0].status, 'sent');
      assert.ok(updateCall.args[0].sent_at);
    });

    it('throws on error', async () => {
      setup([{ error: { message: 'update failed' } }]);
      await assert.rejects(() => markBatchSent(['id-1']), { message: /Failed to mark batch/ });
    });
  });

  describe('markBatchFailed', () => {
    it('updates status to failed', async () => {
      setup([{ error: null }]);
      await markBatchFailed(['id-1']);

      const updateCall = mockClient.calls.find((c) => c.method === 'update');
      assert.equal(updateCall.args[0].status, 'failed');
    });
  });
});
