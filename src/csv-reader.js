import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import * as log from './logger.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function readCsv(filePath, columnMapping) {
  const contacts = [];
  const seen = new Set();
  let skipped = 0;

  const parser = createReadStream(filePath).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      delimiter: [',', ';'],
    })
  );

  for await (const row of parser) {
    const email = (row[columnMapping.email] || '').trim().toLowerCase();

    if (!email || !EMAIL_REGEX.test(email)) {
      skipped++;
      continue;
    }

    if (seen.has(email)) {
      skipped++;
      continue;
    }

    seen.add(email);
    contacts.push({
      email,
      firstName: (row[columnMapping.firstName] || '').trim(),
      lastName: (row[columnMapping.lastName] || '').trim(),
      organization: (row[columnMapping.organization] || '').trim(),
    });
  }

  log.info(`Parsed ${contacts.length} valid contacts from ${filePath} (${skipped} skipped)`);
  return contacts;
}

export function batchContacts(contacts, batchSize) {
  const batches = [];
  for (let i = 0; i < contacts.length; i += batchSize) {
    batches.push(contacts.slice(i, i + batchSize));
  }
  return batches;
}
