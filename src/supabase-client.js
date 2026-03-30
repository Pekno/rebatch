import { createClient } from '@supabase/supabase-js';
import * as log from './logger.js';

let supabase;

export function initSupabase(url, serviceKey) {
  supabase = createClient(url, serviceKey);
  return supabase;
}

/** @internal — used by tests to inject a mock client */
export function _setClientForTesting(client) {
  supabase = client;
}

/**
 * Import contacts into email_recipients table.
 * One row per email — appends group to group_names array and fills empty fields.
 * Cross-checks against the Resend segment to skip already-contacted contacts.
 *
 * @param {Set<string>} segmentEmails - Lowercased emails already in the Resend segment (already contacted)
 */
export async function importContacts(contacts, groupName, segmentEmails, onProgress) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let alreadyContacted = 0;

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const emailLower = contact.email.toLowerCase();
    const isInSegment = segmentEmails.has(emailLower);

    const skipStatus = isInSegment ? 'already_contacted' : null;

    // Check if email already exists in email_recipients
    const { data: existing, error: selectError } = await supabase
      .from('email_recipients')
      .select('id, first_name, last_name, organization, group_names, status')
      .eq('email', contact.email)
      .maybeSingle();

    if (selectError) {
      if (i === 0) log.warn(`Select error: ${selectError.message} (code: ${selectError.code})`);
      skipped++;
      if (onProgress) onProgress(i + 1);
      continue;
    }

    if (existing) {
      // Build update: append group if not already present, fill empty fields
      const groups = existing.group_names || [];
      const hasGroup = groups.includes(groupName);
      const needsFill =
        (!existing.first_name && contact.firstName) ||
        (!existing.last_name && contact.lastName) ||
        (!existing.organization && contact.organization);
      const needsStatusUpdate =
        skipStatus && existing.status === 'pending';

      if (!hasGroup || needsFill || needsStatusUpdate) {
        const updateData = {};
        if (!hasGroup) updateData.group_names = [...groups, groupName];
        if (!existing.first_name && contact.firstName) updateData.first_name = contact.firstName;
        if (!existing.last_name && contact.lastName) updateData.last_name = contact.lastName;
        if (!existing.organization && contact.organization) updateData.organization = contact.organization;
        if (needsStatusUpdate) updateData.status = skipStatus;

        const { error } = await supabase
          .from('email_recipients')
          .update(updateData)
          .eq('id', existing.id);

        if (error) {
          skipped++;
        } else if (needsStatusUpdate && skipStatus === 'already_contacted') {
          alreadyContacted++;
        } else {
          updated++;
        }
      } else {
        skipped++;
      }
    } else {
      // Insert new row
      const status = skipStatus || 'pending';
      const { error } = await supabase.from('email_recipients').insert({
        email: contact.email,
        first_name: contact.firstName || null,
        last_name: contact.lastName || null,
        organization: contact.organization || null,
        group_names: [groupName],
        status,
      });

      if (error) {
        if (i === 0) log.warn(`Insert error: ${error.message} (code: ${error.code})`);
        skipped++;
      } else if (skipStatus === 'already_contacted') {
        alreadyContacted++;
      } else {
        inserted++;
      }
    }

    if (onProgress) onProgress(i + 1);
  }

  return { inserted, updated, skipped, alreadyContacted };
}

/**
 * Check if a group exists (has any recipients).
 */
export async function groupExists(groupName) {
  const { count, error } = await supabase
    .from('email_recipients')
    .select('*', { count: 'exact', head: true })
    .contains('group_names', [groupName]);

  if (error) throw new Error(`Failed to check group: ${error.message}`);
  return (count || 0) > 0;
}

/**
 * Delete all recipients that belong to a group.
 * If a recipient belongs to multiple groups, only remove this group from their group_names array.
 * If it's their only group, delete the row entirely.
 */
export async function deleteGroupRecipients(groupName) {
  // First get all recipients in this group
  let allRecipients = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('email_recipients')
      .select('id, group_names')
      .contains('group_names', [groupName])
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Failed to query recipients: ${error.message}`);
    if (!data || data.length === 0) break;
    allRecipients = allRecipients.concat(data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  let deleted = 0;
  let ungrouped = 0;

  for (const recipient of allRecipients) {
    const otherGroups = (recipient.group_names || []).filter((g) => g !== groupName);

    if (otherGroups.length === 0) {
      // Only group — delete the row
      const { error } = await supabase
        .from('email_recipients')
        .delete()
        .eq('id', recipient.id);
      if (!error) deleted++;
    } else {
      // Multiple groups — just remove this group
      const { error } = await supabase
        .from('email_recipients')
        .update({ group_names: otherGroups })
        .eq('id', recipient.id);
      if (!error) ungrouped++;
    }
  }

  return { deleted, ungrouped, total: allRecipients.length };
}

/**
 * Get all pending recipients for a group (not sent, not unsubscribed).
 */
export async function getPendingRecipients(groupName) {
  const { data, error } = await supabase
    .from('email_recipients')
    .select('id, email, first_name, last_name, organization, group_names, unsubscribe_token')
    .contains('group_names', [groupName])
    .in('status', ['pending', 'failed'])
    .is('unsubscribed_at', null)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to query recipients: ${error.message}`);
  return data || [];
}

/**
 * Get counts for a group (for summary display).
 */
export async function getGroupStats(groupName) {
  const { count: total } = await supabase
    .from('email_recipients')
    .select('*', { count: 'exact', head: true })
    .contains('group_names', [groupName]);

  const { count: pending } = await supabase
    .from('email_recipients')
    .select('*', { count: 'exact', head: true })
    .contains('group_names', [groupName])
    .in('status', ['pending', 'failed'])
    .is('unsubscribed_at', null);

  const { count: failed } = await supabase
    .from('email_recipients')
    .select('*', { count: 'exact', head: true })
    .contains('group_names', [groupName])
    .eq('status', 'failed');

  const { count: sent } = await supabase
    .from('email_recipients')
    .select('*', { count: 'exact', head: true })
    .contains('group_names', [groupName])
    .eq('status', 'sent');

  const { count: alreadyContacted } = await supabase
    .from('email_recipients')
    .select('*', { count: 'exact', head: true })
    .contains('group_names', [groupName])
    .eq('status', 'already_contacted');

  const { count: unsubscribed } = await supabase
    .from('email_recipients')
    .select('*', { count: 'exact', head: true })
    .contains('group_names', [groupName])
    .not('unsubscribed_at', 'is', null);

  return {
    total: total || 0,
    pending: pending || 0,
    failed: failed || 0,
    sent: sent || 0,
    alreadyContacted: alreadyContacted || 0,
    unsubscribed: unsubscribed || 0,
  };
}

/**
 * Mark a batch of recipients as sent.
 */
export async function markBatchSent(recipientIds) {
  const { error } = await supabase
    .from('email_recipients')
    .update({ status: 'sent', sent_at: new Date().toISOString() })
    .in('id', recipientIds);

  if (error) throw new Error(`Failed to mark batch as sent: ${error.message}`);
}

/**
 * Mark a batch of recipients as failed.
 */
export async function markBatchFailed(recipientIds) {
  const { error } = await supabase
    .from('email_recipients')
    .update({ status: 'failed' })
    .in('id', recipientIds);

  if (error) log.warn(`Failed to mark batch as failed: ${error.message}`);
}
