import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, setJsonMode, isJsonMode, jsonOut } from '../src/logger.js';

describe('formatDuration', () => {
  it('formats seconds', () => {
    assert.equal(formatDuration(5000), '5s');
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(59000), '59s');
  });

  it('formats minutes and seconds', () => {
    assert.equal(formatDuration(60000), '1m0s');
    assert.equal(formatDuration(90000), '1m30s');
    assert.equal(formatDuration(3599000), '59m59s');
  });

  it('formats hours and minutes', () => {
    assert.equal(formatDuration(3600000), '1h0m');
    assert.equal(formatDuration(3660000), '1h1m');
    assert.equal(formatDuration(7260000), '2h1m');
  });
});

describe('jsonMode', () => {
  beforeEach(() => {
    setJsonMode(false);
  });

  it('defaults to false', () => {
    assert.equal(isJsonMode(), false);
  });

  it('can be toggled on and off', () => {
    setJsonMode(true);
    assert.equal(isJsonMode(), true);
    setJsonMode(false);
    assert.equal(isJsonMode(), false);
  });

  it('jsonOut writes JSON to stdout when enabled', (t) => {
    setJsonMode(true);
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args));

    jsonOut({ type: 'test', value: 42 });

    assert.equal(logs.length, 1);
    const parsed = JSON.parse(logs[0][0]);
    assert.equal(parsed.type, 'test');
    assert.equal(parsed.value, 42);
  });

  it('jsonOut does nothing when disabled', (t) => {
    setJsonMode(false);
    const logs = [];
    t.mock.method(console, 'log', (...args) => logs.push(args));

    jsonOut({ type: 'test' });

    assert.equal(logs.length, 0);
  });
});
