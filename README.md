# ![Logo](logo.png)

<div align="center">

![GitHub Tag](https://img.shields.io/github/v/tag/pekno/rebatch?label=latest%20version)
[![npm version](https://img.shields.io/npm/v/%40pekno%2Frebatch)](https://www.npmjs.com/package/@pekno/rebatch)
[![npm downloads](https://img.shields.io/npm/dm/%40pekno%2Frebatch)](https://www.npmjs.com/package/@pekno/rebatch)
[![Tests](https://github.com/pekno/rebatch/actions/workflows/test.yml/badge.svg)](https://github.com/pekno/rebatch/actions/workflows/test.yml)
![License](https://img.shields.io/github/license/pekno/rebatch)

</div>

CLI tool to send bulk emails via Resend's free-tier Marketing/Broadcast API, with Supabase as the tracking database.

## Why this tool exists

Resend's transactional email limits (100/day, 3000/month on the free tier) are too restrictive for large contact lists. The Marketing/Broadcast API has much higher limits but caps audiences at 1000 contacts and 3 segments. This tool works around those limits by batching: it adds ~100 contacts to a segment, sends a broadcast, removes them, and repeats — tracking everything in Supabase.

## How it works

```
CSV files ──► Supabase (import) ──► Resend Broadcast (send) ──► Supabase status update
```

### The batching process

Because Resend limits audiences to 1000 contacts, the tool sends emails in small batches (~100 contacts). For each batch:

1. **Add contacts** to the Resend segment (with their properties including `unsubscribe_token`)
2. **Create a broadcast** using your Resend template
3. **Send the broadcast** to the segment
4. **Wait** for delivery confirmation (polls broadcast status)
5. **Remove contacts** from the segment (only the ones we added — pre-existing contacts are protected)
6. **Update Supabase** — mark recipients as `sent`

This cycle repeats for every batch until all pending recipients are processed. The process is **resumable**: if interrupted, re-run the same command and it picks up where it left off.

### Unsubscribe handling

Because contacts are removed from Resend after each batch, Resend cannot manage unsubscribe status for you. The `init` command **automatically deploys a Supabase Edge Function** that handles unsubscriptions — no external hosting required.

Each contact gets a unique `unsubscribe_token` (UUID). In your Resend email template, add the unsubscribe link printed at the end of `init`:

```html
<a href="https://<your-project-ref>.supabase.co/functions/v1/unsubscribe?token={{{contact.unsubscribe_token}}}">Unsubscribe</a>
```

When a recipient clicks the link, the Edge Function updates their `unsubscribed_at` timestamp in Supabase and shows a confirmation page. The `send` command automatically skips any recipient where `unsubscribed_at` is set.

## Prerequisites

- **Node.js 22+**
- **Supabase** project + personal access token (Account > Access Tokens)
- **Resend** account with API key (an audience is created automatically during init)
- **Resend email template** created beforehand (see below)

## Setup

### 1. Install

```bash
npm install -g @pekno/rebatch
```

### 2. Create your Resend template

Before using this tool, create an email template in the **Resend dashboard** (Templates section). This template is what will be sent to your contacts.

In the template, you can use Resend's contact properties as variables:
- `{{{contact.first_name}}}` — recipient's first name
- `{{{contact.last_name}}}` — recipient's last name
- `{{{contact.company_name}}}` — recipient's organization
- `{{{contact.unsubscribe_token}}}` — unique unsubscribe UUID (see [Unsubscribe handling](#unsubscribe-handling))

You will reference this template by its exact name when running the `send` command.

### 3. Configure

```bash
rebatch init
```

The `init` command will:
1. Prompt for your Resend API key
2. Automatically create (or reuse) a `rebatch` audience in Resend
3. Connect to Supabase via your access token and let you pick a project
3. Auto-fetch the project's API keys
4. Create the `email_recipients` table
5. Deploy the unsubscribe Edge Function
6. Print the unsubscribe link to paste in your Resend template

Config location:
- **Windows**: `%APPDATA%/rebatch/config.json`
- **macOS**: `~/Library/Application Support/rebatch/config.json`
- **Linux**: `~/.config/rebatch/config.json`

You only need two credentials:

| Field | Where to find it |
|-------|-----------------|
| `resendApiKey` | Resend dashboard > API Keys |
| `supabaseAccessToken` | Supabase dashboard > Account > Access Tokens |

## Usage

### Import contacts (CSV to Supabase)

```bash
# Preview what will be imported
rebatch import my-group --csv ./contacts.csv --dry-run

# Import for real
rebatch import my-group --csv ./contacts.csv
```

Imports contacts into the `email_recipients` Supabase table. Skips duplicates, invalid emails, and contacts already present in the Resend segment.

Expected CSV columns: `email`, `firstname`, `lastname` (configurable via `csvColumns` in config). The CSV reader auto-detects comma and semicolon delimiters.

### Send emails (Supabase to Resend Broadcast)

```bash
# Preview batches and recipients
rebatch send my-group --template "My Template Name" --dry-run

# Send for real
rebatch send my-group --template "My Template Name"
```

**Resumable**: if interrupted, re-run the same command. Only `pending` and `failed` recipients are processed.

### Check status

```bash
rebatch status my-group
```

Shows total, pending, sent, failed, and unsubscribed counts with a progress bar.

### Delete a group

```bash
rebatch delete my-group
```

Deletes all recipients in a group from Supabase (with confirmation prompt).

### Show config path

```bash
rebatch config
```

## Configuration reference

| Field | Default | Description |
|-------|---------|-------------|
| `resendApiKey` | — | Resend API key |
| `segmentId` | — | Resend audience ID (auto-created during init) |
| `supabaseAccessToken` | — | Supabase personal access token (used during init) |
| `supabaseUrl` | — | Supabase project URL (auto-fetched) |
| `supabaseServiceKey` | — | Supabase service role key (auto-fetched) |
| `fromEmail` | — | Sender (e.g., `"Name <you@example.com>"`) |
| `replyTo` | — | Reply-to email address |
| `batchSize` | `100` | Contacts per batch |
| `pollIntervalMs` | `5000` | Broadcast status poll interval |
| `pollTimeoutMs` | `300000` | Max wait for broadcast delivery (5 min) |
| `rateLimitDelayMs` | `600` | Delay between API calls (ms) |
| `csvColumns` | — | Maps CSV headers to fields |

## Rate limiting

Resend enforces a **2 requests/second** limit. The `rateLimitDelayMs` config value (default `600`) controls the minimum wait between API calls. If a 429 is still received, the tool automatically retries with increasing backoff (up to 5 retries).

## Estimated runtime

Runtime depends on your contact list size. Each batch of 100 contacts takes ~3-4 minutes (adding contacts, sending, polling, removing). For example, ~6500 contacts = ~65 batches = ~4 hours. The process can run unattended.

## Testing

```bash
npm test                # run all 64 tests
npm run test:coverage   # run with coverage report
```

All external APIs are mocked — no credentials needed. Tests cover CSV parsing, Resend API retry/rate-limiting, Supabase query logic, the batch orchestration loop, and CLI argument validation.

See **[TEST.md](TEST.md)** for full documentation of every test case with links to source.

## License

MIT
