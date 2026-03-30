import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getEdgeFunctionSource } from '../src/edge-function.js';

describe('getEdgeFunctionSource', () => {
  it('returns a non-empty string', () => {
    const source = getEdgeFunctionSource();
    assert.equal(typeof source, 'string');
    assert.ok(source.length > 0);
  });

  it('contains expected Deno and Supabase markers', () => {
    const source = getEdgeFunctionSource();
    assert.ok(source.includes('Deno.serve'), 'should contain Deno.serve');
    assert.ok(source.includes('createClient'), 'should contain createClient');
    assert.ok(source.includes('email_recipients'), 'should reference email_recipients table');
    assert.ok(source.includes('unsubscribe_token'), 'should reference unsubscribe_token');
  });

  it('contains HTML response generation', () => {
    const source = getEdgeFunctionSource();
    assert.ok(source.includes('function html('), 'should contain html helper function');
    assert.ok(source.includes('Content-Type'), 'should set content type header');
  });
});
