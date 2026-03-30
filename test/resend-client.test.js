import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ResendClient } from '../src/resend-client.js';

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function textResponse(body, status) {
  return new Response(body, { status });
}

describe('ResendClient', () => {
  let client;
  let fetchMock;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new ResendClient('test-api-key', 0); // 0ms delay for fast tests
    // Override delay to be instant
    client.delay = () => Promise.resolve();
    fetchMock = mock.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('request', () => {
    it('sends GET with auth header', async () => {
      fetchMock.mock.mockImplementation(() => jsonResponse({ data: [1, 2] }));

      const result = await client.request('GET', '/contacts');

      assert.deepStrictEqual(result, { data: [1, 2] });
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, 'https://api.resend.com/contacts');
      assert.equal(opts.method, 'GET');
      assert.equal(opts.headers.Authorization, 'Bearer test-api-key');
    });

    it('sends POST with JSON body', async () => {
      fetchMock.mock.mockImplementation(() => jsonResponse({ id: 'bc_123' }));

      await client.request('POST', '/broadcasts', { subject: 'Hello' });

      const [, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(opts.method, 'POST');
      assert.deepStrictEqual(JSON.parse(opts.body), { subject: 'Hello' });
    });

    it('returns null for 204 responses', async () => {
      fetchMock.mock.mockImplementation(() => new Response(null, { status: 204 }));

      const result = await client.request('DELETE', '/contacts/c_123');

      assert.equal(result, null);
    });

    it('retries on 429 then succeeds', async () => {
      let callCount = 0;
      fetchMock.mock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Response('rate limited', { status: 429, headers: {} });
        }
        return jsonResponse({ ok: true });
      });

      const result = await client.request('GET', '/contacts');

      assert.deepStrictEqual(result, { ok: true });
      assert.equal(fetchMock.mock.callCount(), 2);
    });

    it('retries on 429 and respects retry-after header', async () => {
      const delays = [];
      client.delay = (ms) => {
        delays.push(ms);
        return Promise.resolve();
      };

      let callCount = 0;
      fetchMock.mock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '3' },
          });
        }
        return jsonResponse({ ok: true });
      });

      await client.request('GET', '/contacts');

      // Should have a 3000ms delay (retry-after * 1000)
      assert.ok(delays.includes(3000), `Expected 3000ms delay, got: ${delays}`);
    });

    it('retries on 500 then succeeds', async () => {
      let callCount = 0;
      fetchMock.mock.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) return textResponse('Internal Error', 500);
        return jsonResponse({ ok: true });
      });

      const result = await client.request('GET', '/test');

      assert.deepStrictEqual(result, { ok: true });
      assert.equal(fetchMock.mock.callCount(), 3);
    });

    it('throws after exhausting retries on 500', async () => {
      fetchMock.mock.mockImplementation(() => textResponse('Server Error', 500));

      await assert.rejects(() => client.request('GET', '/test'), {
        message: /Server error 500/,
      });
      assert.equal(fetchMock.mock.callCount(), 5); // MAX_RETRIES
    });

    it('throws immediately on non-retryable 4xx', async () => {
      fetchMock.mock.mockImplementation(() => textResponse('Not Found', 404));

      await assert.rejects(() => client.request('GET', '/test'), {
        message: /API error 404/,
      });
      assert.equal(fetchMock.mock.callCount(), 1);
    });

    it('retries on network error then succeeds', async () => {
      let callCount = 0;
      fetchMock.mock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('ECONNRESET');
        return jsonResponse({ ok: true });
      });

      const result = await client.request('GET', '/test');

      assert.deepStrictEqual(result, { ok: true });
      assert.equal(fetchMock.mock.callCount(), 2);
    });

    it('throws after exhausting retries on network error', async () => {
      fetchMock.mock.mockImplementation(() => {
        throw new Error('ECONNRESET');
      });

      await assert.rejects(() => client.request('GET', '/test'), {
        message: /ECONNRESET/,
      });
      assert.equal(fetchMock.mock.callCount(), 5);
    });
  });

  describe('addContact', () => {
    it('sends correct payload', async () => {
      fetchMock.mock.mockImplementation(() => jsonResponse({ id: 'c_1' }));

      await client.addContact('seg_1', {
        email: 'a@example.com',
        firstName: 'Alice',
        lastName: 'Smith',
        properties: { company_name: 'Acme' },
      });

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      assert.equal(body.email, 'a@example.com');
      assert.equal(body.first_name, 'Alice');
      assert.equal(body.last_name, 'Smith');
      assert.deepStrictEqual(body.segments, [{ id: 'seg_1' }]);
      assert.equal(body.unsubscribed, false);
      assert.equal(body.properties.company_name, 'Acme');
    });
  });

  describe('listContacts', () => {
    it('returns data array', async () => {
      fetchMock.mock.mockImplementation(() =>
        jsonResponse({ data: [{ id: 'c_1', email: 'a@x.com' }] })
      );

      const result = await client.listContacts();
      assert.equal(result.length, 1);
      assert.equal(result[0].email, 'a@x.com');
    });

    it('returns empty array when data is null', async () => {
      fetchMock.mock.mockImplementation(() => jsonResponse({}));

      const result = await client.listContacts();
      assert.deepStrictEqual(result, []);
    });
  });

  describe('getTemplateByName', () => {
    it('resolves template by name', async () => {
      let callCount = 0;
      fetchMock.mock.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // listTemplates
          return jsonResponse({ data: [{ id: 't_1', name: 'Welcome' }] });
        }
        // getTemplate
        return jsonResponse({ id: 't_1', name: 'Welcome', subject: 'Hi', html: '<p>Hi</p>' });
      });

      const template = await client.getTemplateByName('Welcome');

      assert.equal(template.id, 't_1');
      assert.equal(template.subject, 'Hi');
    });

    it('throws when template not found', async () => {
      fetchMock.mock.mockImplementation(() =>
        jsonResponse({ data: [{ id: 't_1', name: 'Other' }] })
      );

      await assert.rejects(() => client.getTemplateByName('Missing'), {
        message: /Template "Missing" not found.*Available: Other/,
      });
    });
  });

  describe('createBroadcast', () => {
    it('sends correct payload', async () => {
      fetchMock.mock.mockImplementation(() => jsonResponse({ id: 'bc_1' }));

      await client.createBroadcast({
        segmentId: 'seg_1',
        from: 'sender@x.com',
        replyTo: 'reply@x.com',
        subject: 'Test',
        html: '<p>Test</p>',
        name: 'Batch 1',
      });

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      assert.equal(body.segment_id, 'seg_1');
      assert.equal(body.from, 'sender@x.com');
      assert.equal(body.subject, 'Test');
      assert.equal(body.name, 'Batch 1');
    });
  });
});
