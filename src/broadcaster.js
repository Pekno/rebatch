import * as log from './logger.js';
import { ProgressBar } from './logger.js';
import { markBatchSent, markBatchFailed } from './supabase-client.js';

export async function runBatches(client, config, groupName, batches, html, subject) {
  const totalBatches = batches.length;
  const totalRecipients = batches.reduce((sum, b) => sum + b.length, 0);
  let processedCount = 0;
  const globalStart = Date.now();

  // Snapshot pre-existing segment contacts so we never delete them
  const s = log.spinner('Snapshotting existing segment contacts...');
  s.start();
  const existingContacts = await client.listContacts();
  const protectedContactIds = new Set(existingContacts.map((c) => c.id));
  s.succeed(`Found ${protectedContactIds.size} pre-existing contacts (protected)`);
  console.log('');

  log.header(`Sending ${totalRecipients} emails in ${totalBatches} batches`);

  const overallBar = new ProgressBar({ total: totalRecipients, label: 'Overall', width: 35 });
  overallBar.update();
  console.log('');

  for (let i = 0; i < totalBatches; i++) {
    const batch = batches[i];
    const batchIds = batch.map((r) => r.id);

    console.log(`\n  Batch ${i + 1}/${totalBatches} (${batch.length} recipients)`);

    let addedContactIds = [];

    try {
      // Step 0: Add contacts
      log.stepStart(0);
      addedContactIds = await addContacts(client, config.segmentId, batch);
      log.stepDone(0);

      // Step 1: Create broadcast
      log.stepStart(1);
      const broadcastName = `${groupName} - Batch ${i + 1}`;
      const broadcast = await client.createBroadcast({
        segmentId: config.segmentId,
        from: config.fromEmail,
        replyTo: config.replyTo,
        subject,
        html,
        name: broadcastName,
      });
      log.stepDone(1);

      // Step 2: Send broadcast
      log.stepStart(2);
      await client.sendBroadcast(broadcast.id);
      log.stepDone(2);

      // Step 3: Poll for completion
      log.stepStart(3);
      await pollBroadcast(client, broadcast.id, config.pollIntervalMs, config.pollTimeoutMs);
      log.stepDone(3);

      // Step 4: Remove contacts from segment; delete only newly-created ones
      log.stepStart(4);
      await removeBatchContacts(client, addedContactIds, protectedContactIds, config.segmentId);
      log.stepDone(4);

      // Step 5: Mark as sent in Supabase
      log.stepStart(5);
      await markBatchSent(batchIds);
      log.stepDone(5);

      processedCount += batch.length;

      // Update overall progress bar
      console.log('');
      for (let j = 0; j < batch.length; j++) overallBar.tick();
      console.log('');

    } catch (err) {
      log.stepFail(-1);
      log.error(`Batch ${i + 1} failed: ${err.message}`);
      await markBatchFailed(batchIds);
      try {
        await removeBatchContacts(client, addedContactIds, protectedContactIds, config.segmentId);
      } catch (cleanupErr) {
        log.warn(`Cleanup failed: ${cleanupErr.message}`);
      }
      throw err;
    }
  }

  console.log('');
  log.success(`All done! ${processedCount} emails sent across ${totalBatches} batches.`);
}

async function addContacts(client, segmentId, batch) {
  const addedIds = [];
  for (const recipient of batch) {
    try {
      const firstName = recipient.first_name || '';
      const lastName = recipient.last_name || '';
      const properties = {};
      if (recipient.organization) properties.company_name = recipient.organization;
      if (recipient.unsubscribe_token) properties.unsubscribe_token = recipient.unsubscribe_token;
      const result = await client.addContact(segmentId, {
        email: recipient.email,
        firstName,
        lastName,
        properties,
      });
      if (result?.id) addedIds.push(result.id);
    } catch (err) {
      // Don't log per-contact errors to avoid breaking the step line
    }
  }
  return addedIds;
}

async function removeBatchContacts(client, contactIds, protectedContactIds, segmentId) {
  for (const contactId of contactIds) {
    try {
      if (protectedContactIds.has(contactId)) {
        // Pre-existing contact: only remove from segment, don't delete
        await client.removeContactFromSegment(contactId, segmentId);
      } else {
        await client.removeContact(contactId);
      }
    } catch (err) {
      // Silent — step-level error shown if entire step fails
    }
  }
}

async function pollBroadcast(client, broadcastId, intervalMs, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const broadcast = await client.getBroadcast(broadcastId);
      if (broadcast.status === 'sent' || broadcast.status === 'completed') {
        return;
      }
    } catch (err) {
      // Silent — retry on next poll
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
