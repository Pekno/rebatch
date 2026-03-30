import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readCsv, batchContacts } from '../src/csv-reader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, 'fixtures');

const defaultColumns = {
  email: 'email',
  firstName: 'firstname',
  lastName: 'lastname',
  organization: 'organization',
};

describe('readCsv', () => {
  it('parses a valid CSV with all columns', async () => {
    const contacts = await readCsv(join(fixtures, 'valid.csv'), defaultColumns);
    assert.equal(contacts.length, 5);
    assert.deepStrictEqual(contacts[0], {
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Smith',
      organization: 'Acme Inc',
    });
  });

  it('deduplicates emails by lowercase', async () => {
    const contacts = await readCsv(join(fixtures, 'duplicates.csv'), defaultColumns);
    assert.equal(contacts.length, 2);
    const emails = contacts.map((c) => c.email);
    assert.deepStrictEqual(emails, ['alice@example.com', 'bob@example.com']);
  });

  it('skips invalid emails', async () => {
    const contacts = await readCsv(join(fixtures, 'invalid-emails.csv'), defaultColumns);
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].email, 'valid@example.com');
    assert.equal(contacts[1].email, 'also-valid@test.org');
  });

  it('handles semicolon delimiters', async () => {
    const contacts = await readCsv(join(fixtures, 'semicolons.csv'), defaultColumns);
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].firstName, 'Alice');
  });

  it('handles UTF-8 BOM', async () => {
    const contacts = await readCsv(join(fixtures, 'bom.csv'), defaultColumns);
    assert.equal(contacts.length, 2);
    assert.equal(contacts[0].email, 'alice@example.com');
  });

  it('returns empty array for header-only CSV', async () => {
    const contacts = await readCsv(join(fixtures, 'empty.csv'), defaultColumns);
    assert.equal(contacts.length, 0);
  });
});

describe('batchContacts', () => {
  it('splits contacts into even batches', () => {
    const contacts = Array.from({ length: 10 }, (_, i) => ({ email: `u${i}@x.com` }));
    const batches = batchContacts(contacts, 3);
    assert.equal(batches.length, 4);
    assert.equal(batches[0].length, 3);
    assert.equal(batches[3].length, 1);
  });

  it('returns single batch when batchSize > contacts', () => {
    const contacts = [{ email: 'a@x.com' }, { email: 'b@x.com' }];
    const batches = batchContacts(contacts, 100);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
  });

  it('returns empty array for empty input', () => {
    const batches = batchContacts([], 10);
    assert.deepStrictEqual(batches, []);
  });
});
