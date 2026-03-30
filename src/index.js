#!/usr/bin/env node

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import updateNotifier from 'update-notifier';
import { ResendClient } from './resend-client.js';
import { readCsv, batchContacts } from './csv-reader.js';
import { initSupabase, importContacts, getPendingRecipients, getGroupStats, groupExists, deleteGroupRecipients } from './supabase-client.js';
import { runBatches } from './broadcaster.js';
import { runInit, getConfigPath } from './init.js';
import * as log from './logger.js';

// ---------------------------------------------------------------------------
// Update notifier — checks npm registry in background, shows notice if outdated
// ---------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const pkg = require('../package.json');
updateNotifier({ pkg }).notify({ isGlobal: true });

// ---------------------------------------------------------------------------
// CLI setup
// ---------------------------------------------------------------------------
const program = new Command();

// Show banner before help output
program.addHelpText('beforeAll', () => {
  log.showBanner();
  return '';
});

program.hook('preAction', (thisCommand) => {
  const opts = thisCommand.optsWithGlobals();
  if (opts.json) {
    log.setJsonMode(true);
  }
});

function loadConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    log.error(`Config not found at ${configPath}. Run "rebatch init" to create one.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

async function requireGroup(groupName) {
  const exists = await groupExists(groupName);
  if (!exists) {
    log.error(`Group "${groupName}" does not exist. Import contacts first with: rebatch import ${groupName} --csv <path>`);
    process.exit(1);
  }
}

function initServices(config) {
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    log.error('Missing supabaseUrl or supabaseServiceKey in config');
    process.exit(1);
  }
  initSupabase(config.supabaseUrl, config.supabaseServiceKey);
}

program
  .name('rebatch')
  .description('rebatch \u2014 Bulk email sender via Resend Broadcast API with Supabase tracking')
  .version(pkg.version)
  .option('--json', 'Output structured JSON instead of human-readable text');

program
  .command('init')
  .description('Interactive setup: create config and Supabase schema')
  .action(async () => {
    await runInit();
  });

program
  .command('import <group>')
  .description('Import CSV contacts into Supabase')
  .requiredOption('--csv <path>', 'Path to the CSV file')
  .option('--dry-run', 'Preview without making changes')
  .action(async (groupName, opts) => {
    if (!log.isJsonMode()) log.showBanner();
    const config = loadConfig();
    initServices(config);
    await handleImport(config, groupName, opts.csv, opts.dryRun);
  });

program
  .command('send <group>')
  .description('Send emails to pending recipients via Resend Broadcast')
  .requiredOption('--template <name>', 'Resend template name')
  .option('--dry-run', 'Preview without sending')
  .action(async (groupName, opts) => {
    if (!log.isJsonMode()) log.showBanner();
    const config = loadConfig();
    initServices(config);
    await requireGroup(groupName);
    await handleSend(config, groupName, opts.template, opts.dryRun);
  });

program
  .command('status <group>')
  .description('Show group statistics from Supabase')
  .action(async (groupName) => {
    if (!log.isJsonMode()) log.showBanner();
    const config = loadConfig();
    initServices(config);
    await requireGroup(groupName);
    await handleStatus(groupName);
  });

program
  .command('delete <group>')
  .description('Delete all recipients in a group from Supabase')
  .action(async (groupName) => {
    if (!log.isJsonMode()) log.showBanner();
    const config = loadConfig();
    initServices(config);
    await requireGroup(groupName);
    await handleDelete(groupName);
  });

program
  .command('config')
  .description('Show config file path')
  .action(() => {
    if (log.isJsonMode()) {
      log.jsonOut({ type: 'config', path: getConfigPath() });
    } else {
      console.log(getConfigPath());
    }
  });

async function handleImport(config, groupName, csvFile, dryRun) {
  const csvPath = resolve(csvFile);
  if (!existsSync(csvPath)) {
    log.error(`CSV file not found: ${csvPath}`);
    process.exit(1);
  }

  const s1 = log.spinner('Reading CSV...');
  s1.start();
  const contacts = await readCsv(csvPath, config.csvColumns);
  s1.succeed(`Read ${contacts.length} valid contacts from CSV`);

  if (contacts.length === 0) {
    log.error('No valid contacts found in CSV');
    process.exit(1);
  }

  log.header(`Import: ${groupName}`);
  log.keyValue('CSV file', csvFile);
  log.keyValue('Valid contacts', contacts.length);
  console.log('');

  // Fetch existing Resend segment contacts to skip already-contacted people
  const s2 = log.spinner('Fetching existing Resend segment contacts...');
  s2.start();
  const resendClient = new ResendClient(config.resendApiKey, config.rateLimitDelayMs);
  const segmentContacts = await resendClient.listContacts();
  const segmentEmails = new Set(segmentContacts.map((c) => c.email.toLowerCase()));
  s2.succeed(`Found ${segmentEmails.size} contacts in Resend segment`);
  console.log('');

  if (dryRun) {
    if (log.isJsonMode()) {
      log.jsonOut({
        type: 'import',
        dryRun: true,
        group: groupName,
        contactCount: contacts.length,
        segmentCount: segmentEmails.size,
        preview: contacts.slice(0, 5).map((c) => ({
          email: c.email,
          name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.organization || null,
        })),
      });
      return;
    }
    log.info('DRY RUN \u2014 no changes will be made');
    log.info('First 5 contacts:');
    contacts.slice(0, 5).forEach((c) => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.organization || '-';
      log.info(`  ${c.email} (${name})`);
    });
    process.exit(0);
  }

  log.info('Importing contacts into Supabase...');
  const { ProgressBar } = await import('./logger.js');
  const bar = new ProgressBar({ total: contacts.length, label: 'Importing' });
  const { inserted, updated, skipped, alreadyContacted } = await importContacts(contacts, groupName, segmentEmails, (n) => {
    bar.current = n;
    bar.update();
  });
  bar.stop();
  console.log('');

  if (log.isJsonMode()) {
    log.jsonOut({ type: 'import', group: groupName, inserted, updated, skipped, alreadyContacted });
    return;
  }

  log.success(`Import complete: ${inserted} inserted, ${updated} updated, ${alreadyContacted} already contacted, ${skipped} skipped`);
  await handleStatus(groupName);
}

async function handleSend(config, groupName, templateName, dryRun) {
  const client = new ResendClient(config.resendApiKey, config.rateLimitDelayMs);

  // Resolve template from Resend (includes subject and HTML)
  const s1 = log.spinner(`Resolving Resend template: "${templateName}"...`);
  s1.start();
  let template;
  try {
    template = await client.getTemplateByName(templateName);
    s1.succeed(`Template resolved: "${template.name}" (${template.id})`);
  } catch (err) {
    s1.fail(err.message);
    process.exit(1);
  }

  const subject = template.subject;
  const html = template.html;

  const batchSize = config.batchSize || 100;

  // Get pending recipients from Supabase
  const s2 = log.spinner('Querying pending recipients...');
  s2.start();
  const recipients = await getPendingRecipients(groupName);

  if (recipients.length === 0) {
    s2.succeed('No pending recipients to send to. All done!');
    if (log.isJsonMode()) log.jsonOut({ type: 'send', group: groupName, sent: 0, message: 'No pending recipients' });
    process.exit(0);
  }
  s2.succeed(`Found ${recipients.length} pending recipients`);

  const batches = batchContacts(recipients, batchSize);
  const stats = await getGroupStats(groupName);

  // Summary
  log.header(`Send: ${groupName}`);
  log.keyValue('Total in group', stats.total);
  log.keyValue('Already sent', stats.sent);
  log.keyValue('Failed (retry)', stats.failed);
  log.keyValue('Unsubscribed', stats.unsubscribed);
  log.keyValue('Pending', recipients.length);
  log.keyValue('Batch size', batchSize);
  log.keyValue('Batches', batches.length);
  log.keyValue('Template', templateName);
  log.keyValue('Subject', subject);
  log.keyValue('From', config.fromEmail);
  console.log('');

  if (dryRun) {
    if (log.isJsonMode()) {
      log.jsonOut({
        type: 'send',
        dryRun: true,
        group: groupName,
        stats,
        pendingCount: recipients.length,
        batchCount: batches.length,
        batchSize,
        template: templateName,
        subject,
        preview: recipients.slice(0, 5).map((r) => ({
          email: r.email,
          name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.organization || null,
        })),
      });
      return;
    }
    log.info('DRY RUN \u2014 no emails will be sent');
    log.info('First 5 pending recipients:');
    recipients.slice(0, 5).forEach((r) => {
      const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.organization || '-';
      log.info(`  ${r.email} (${name})`);
    });
    log.info('Batch breakdown:');
    batches.forEach((b, i) => log.info(`  Batch ${i + 1}: ${b.length} recipients`));
    process.exit(0);
  }

  // Run
  const startTime = Date.now();

  try {
    await runBatches(client, config, groupName, batches, html, subject);
  } catch (err) {
    log.error(`Fatal error: ${err.message}`);
    log.info('Progress is saved in Supabase. Re-run the same command to resume.');
    process.exit(1);
  }

  const elapsed = Date.now() - startTime;
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);
  const totalSent = batches.reduce((sum, b) => sum + b.length, 0);

  if (log.isJsonMode()) {
    log.jsonOut({
      type: 'send',
      group: groupName,
      sent: totalSent,
      batches: batches.length,
      elapsedMs: elapsed,
      template: templateName,
      subject,
    });
    return;
  }

  log.summaryBox('Send Complete', [
    `Group        ${groupName}`,
    `Sent         ${totalSent} emails`,
    `Batches      ${batches.length}`,
    `Template     ${templateName}`,
    `Duration     ${mins}m ${secs}s`,
  ]);
}

async function handleStatus(groupName) {
  const stats = await getGroupStats(groupName);

  if (log.isJsonMode()) {
    log.jsonOut({ type: 'status', group: groupName, ...stats });
    return;
  }

  log.header(`Status: ${groupName}`);
  log.keyValue('Total', stats.total);
  log.keyValue('Pending', stats.pending);
  log.keyValue('Failed (retry)', stats.failed);
  log.keyValue('Sent', stats.sent);
  log.keyValue('Already contacted', stats.alreadyContacted);
  log.keyValue('Unsubscribed', stats.unsubscribed);

  if (stats.total > 0) {
    const pct = Math.round((stats.sent / stats.total) * 100);
    const width = 30;
    const filled = Math.round(width * (stats.sent / stats.total));
    const bar = `\x1b[32m${'\u2588'.repeat(filled)}\x1b[2m${'\u2591'.repeat(width - filled)}\x1b[0m`;
    console.log(`\n  Progress  ${bar} ${pct}%\n`);
  }
}

async function handleDelete(groupName) {
  const stats = await getGroupStats(groupName);

  if (log.isJsonMode()) {
    // In JSON mode, skip confirmation — assume scripted usage
    log.info('Deleting group recipients...');
    const result = await deleteGroupRecipients(groupName);
    log.jsonOut({ type: 'delete', group: groupName, ...result });
    return;
  }

  log.header(`Delete: ${groupName}`);
  log.keyValue('Recipients in group', stats.total);
  console.log('');

  const confirmed = await p.confirm({
    message: `Delete all ${stats.total} recipients from "${groupName}"?`,
    initialValue: false,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel('Aborted');
    process.exit(0);
  }

  const s = log.spinner('Deleting group recipients...');
  s.start();
  const { deleted, ungrouped, total } = await deleteGroupRecipients(groupName);
  s.succeed(`Done: ${deleted} deleted, ${ungrouped} removed from group (kept in other groups), ${total} total processed`);
}

program.parseAsync();
