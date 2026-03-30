# Test Documentation

rebatch uses the **Node.js built-in test runner** (`node:test`) with no external test framework. Coverage is provided by `c8` via V8 native instrumentation.

All external dependencies (Resend API, Supabase) are mocked — tests run without any API keys or network access.

```bash
npm test                # run all tests
npm run test:coverage   # run with coverage report
```

## Test Structure

```
test/
├── fixtures/               # CSV fixtures used by csv-reader tests
│   ├── valid.csv           # 5 rows, all valid
│   ├── duplicates.csv      # Same email in different casing
│   ├── invalid-emails.csv  # Mix of valid and invalid emails
│   ├── semicolons.csv      # Semicolon-delimited
│   ├── bom.csv             # UTF-8 BOM prefix
│   └── empty.csv           # Header only, no data rows
├── helpers/
│   └── mock-supabase.js    # Chainable Supabase mock client factory
├── csv-reader.test.js
├── resend-client.test.js
├── supabase-client.test.js
├── broadcaster.test.js
├── edge-function.test.js
├── logger.test.js
└── cli.test.js
```

## Mocking Strategy

| Dependency | Technique |
|---|---|
| Resend API (`fetch`) | `global.fetch` replaced with `mock.fn()` per test. Client's `delay()` method overridden to resolve instantly. |
| Supabase client | Chainable mock object ([`mock-supabase.js`](test/helpers/mock-supabase.js)) injected via `_setClientForTesting()`. Each test queues expected responses. |
| File system (CSV) | Real fixture files in [`test/fixtures/`](test/fixtures/) — no fs mocking needed. |
| Timers (retry/polling) | `client.delay` overridden to `Promise.resolve()` so retry tests run instantly. |

---

## CSV Reader — [`test/csv-reader.test.js`](test/csv-reader.test.js)

Tests `src/csv-reader.js` — pure logic with no external API calls. Uses real CSV fixture files.

| Test | Line | What it verifies |
|---|---|---|
| parses a valid CSV with all columns | [L18](test/csv-reader.test.js#L18) | Happy path: email, firstName, lastName, organization extracted from 5-row CSV |
| deduplicates emails by lowercase | [L29](test/csv-reader.test.js#L29) | `ALICE@EXAMPLE.COM` and `alice@example.com` produce one contact |
| skips invalid emails | [L36](test/csv-reader.test.js#L36) | Rows without valid `user@domain.tld` pattern are filtered out |
| handles semicolon delimiters | [L43](test/csv-reader.test.js#L43) | Auto-detection of `;` delimiter works correctly |
| handles UTF-8 BOM | [L49](test/csv-reader.test.js#L49) | BOM bytes at file start don't corrupt the first column header |
| returns empty array for header-only CSV | [L55](test/csv-reader.test.js#L55) | No data rows produces `[]` without error |
| splits contacts into even batches | [L62](test/csv-reader.test.js#L62) | 10 contacts with batchSize 3 yields `[3, 3, 3, 1]` |
| returns single batch when batchSize > contacts | [L70](test/csv-reader.test.js#L70) | 2 contacts with batchSize 100 yields one batch of 2 |
| returns empty array for empty input | [L77](test/csv-reader.test.js#L77) | `batchContacts([], 10)` returns `[]` |

## Resend Client — [`test/resend-client.test.js`](test/resend-client.test.js)

Tests `src/resend-client.js` — the Resend API wrapper with retry logic, rate limiting, and error handling. `global.fetch` is mocked per test.

### `request()` — core HTTP method

| Test | Line | What it verifies |
|---|---|---|
| sends GET with auth header | [L34](test/resend-client.test.js#L34) | Correct URL, method, and `Authorization: Bearer` header |
| sends POST with JSON body | [L46](test/resend-client.test.js#L46) | Request body is JSON-serialized correctly |
| returns null for 204 responses | [L56](test/resend-client.test.js#L56) | DELETE returning 204 (no body) is handled gracefully |
| retries on 429 then succeeds | [L64](test/resend-client.test.js#L64) | Rate limit response triggers retry; second attempt succeeds |
| retries on 429 and respects retry-after header | [L80](test/resend-client.test.js#L80) | `retry-after: 3` header produces a 3000ms wait |
| retries on 500 then succeeds | [L105](test/resend-client.test.js#L105) | Transient server errors are retried automatically |
| throws after exhausting retries on 500 | [L119](test/resend-client.test.js#L119) | After 5 failed attempts, throws with status and path info |
| throws immediately on non-retryable 4xx | [L128](test/resend-client.test.js#L128) | 400/403/404 errors do not trigger retries |
| retries on network error then succeeds | [L137](test/resend-client.test.js#L137) | `fetch` throwing (e.g., ECONNRESET) triggers retry |
| throws after exhausting retries on network error | [L151](test/resend-client.test.js#L151) | 5 consecutive network failures re-throw the original error |

### API methods

| Test | Line | What it verifies |
|---|---|---|
| addContact sends correct payload | [L164](test/resend-client.test.js#L164) | Payload shape: `email`, `first_name`, `last_name`, `segments`, `unsubscribed`, `properties` |
| listContacts returns data array | [L185](test/resend-client.test.js#L185) | Unwraps `{ data: [...] }` response to plain array |
| listContacts returns empty array when data is null | [L195](test/resend-client.test.js#L195) | Handles missing `data` field gracefully |
| getTemplateByName resolves template | [L204](test/resend-client.test.js#L204) | Lists templates, finds match by name, fetches full template |
| getTemplateByName throws when not found | [L222](test/resend-client.test.js#L222) | Error message includes the missing name and available templates |
| createBroadcast sends correct payload | [L234](test/resend-client.test.js#L234) | Payload shape: `segment_id`, `from`, `reply_to`, `subject`, `html`, `name` |

## Supabase Client — [`test/supabase-client.test.js`](test/supabase-client.test.js)

Tests `src/supabase-client.js` — Supabase query helpers for importing, querying, and updating recipients. Uses the chainable mock client.

### `importContacts()`

| Test | Line | What it verifies |
|---|---|---|
| inserts new contacts | [L24](test/supabase-client.test.js#L24) | New email creates a row with `status: 'pending'` and correct `group_names` |
| updates existing contact without group | [L47](test/supabase-client.test.js#L47) | Existing email in another group gets the new group appended |
| marks already-in-segment as already_contacted | [L65](test/supabase-client.test.js#L65) | Contacts present in Resend segment get `status: 'already_contacted'` |
| skips contacts already in group | [L84](test/supabase-client.test.js#L84) | Duplicate group membership is not re-inserted |
| calls onProgress for each contact | [L96](test/supabase-client.test.js#L96) | Progress callback fires with incrementing count |

### Query helpers

| Test | Line | What it verifies |
|---|---|---|
| groupExists returns true when count > 0 | [L114](test/supabase-client.test.js#L114) | Positive count means group exists |
| groupExists returns false when count is 0 | [L120](test/supabase-client.test.js#L120) | Zero count means group does not exist |
| groupExists throws on error | [L126](test/supabase-client.test.js#L126) | Database error surfaces as thrown exception |
| deleteGroupRecipients deletes single-group rows | [L133](test/supabase-client.test.js#L133) | Recipient in only this group gets their row deleted |
| deleteGroupRecipients ungroupes multi-group rows | [L150](test/supabase-client.test.js#L150) | Recipient in multiple groups only loses this group from the array |
| getPendingRecipients returns recipients | [L169](test/supabase-client.test.js#L169) | Returns data array from query |
| getPendingRecipients throws on error | [L178](test/supabase-client.test.js#L178) | Database error surfaces as thrown exception |
| getGroupStats returns all counts | [L185](test/supabase-client.test.js#L185) | All 6 count queries (total, pending, failed, sent, alreadyContacted, unsubscribed) return correct values |

### Status updates

| Test | Line | What it verifies |
|---|---|---|
| markBatchSent updates status to sent | [L209](test/supabase-client.test.js#L209) | Sets `status: 'sent'` and populates `sent_at` timestamp |
| markBatchSent throws on error | [L218](test/supabase-client.test.js#L218) | Database error surfaces as thrown exception |
| markBatchFailed updates status to failed | [L225](test/supabase-client.test.js#L225) | Sets `status: 'failed'` |

## Broadcaster — [`test/broadcaster.test.js`](test/broadcaster.test.js)

Tests `src/broadcaster.js` — the core 6-step batch loop that orchestrates Resend API calls and Supabase status updates. Uses a mock `ResendClient` object and the chainable Supabase mock.

| Test | Line | What it verifies |
|---|---|---|
| completes all 6 steps for a single batch | [L60](test/broadcaster.test.js#L60) | Steps execute in order: add contacts, create broadcast, send, poll, remove, mark sent |
| processes multiple batches sequentially | [L89](test/broadcaster.test.js#L89) | Two batches each go through the full 6-step cycle |
| cleans up and marks failed on error | [L106](test/broadcaster.test.js#L106) | When `createBroadcast` throws, contacts are cleaned up and recipients marked as failed |
| preserves pre-existing segment contacts | [L134](test/broadcaster.test.js#L134) | Contacts already in the segment before the batch are never removed |

## Edge Function — [`test/edge-function.test.js`](test/edge-function.test.js)

Tests `src/edge-function.js` — the Deno Edge Function source generator for unsubscribe handling.

| Test | Line | What it verifies |
|---|---|---|
| returns a non-empty string | [L6](test/edge-function.test.js#L6) | Output is a string with content |
| contains expected Deno and Supabase markers | [L12](test/edge-function.test.js#L12) | Contains `Deno.serve`, `createClient`, `email_recipients`, `unsubscribe_token` |
| contains HTML response generation | [L20](test/edge-function.test.js#L20) | Contains `function html(` and `Content-Type` header |

## Logger — [`test/logger.test.js`](test/logger.test.js)

Tests `src/logger.js` — formatting utilities and JSON output mode. Visual ANSI output is not tested.

### `formatDuration()`

| Test | Line | What it verifies |
|---|---|---|
| formats seconds | [L6](test/logger.test.js#L6) | `5000` -> `"5s"`, `0` -> `"0s"`, `59000` -> `"59s"` |
| formats minutes and seconds | [L12](test/logger.test.js#L12) | `60000` -> `"1m0s"`, `90000` -> `"1m30s"` |
| formats hours and minutes | [L18](test/logger.test.js#L18) | `3600000` -> `"1h0m"`, `3660000` -> `"1h1m"` |

### JSON mode

| Test | Line | What it verifies |
|---|---|---|
| defaults to false | [L30](test/logger.test.js#L30) | JSON mode is off by default |
| can be toggled on and off | [L34](test/logger.test.js#L34) | `setJsonMode(true/false)` correctly toggles state |
| jsonOut writes JSON to stdout when enabled | [L41](test/logger.test.js#L41) | Captures stdout and validates JSON output |
| jsonOut does nothing when disabled | [L54](test/logger.test.js#L54) | No stdout output when JSON mode is off |

## CLI Smoke Tests — [`test/cli.test.js`](test/cli.test.js)

Tests the CLI binary (`src/index.js`) via `child_process.execFile`. Validates wiring, argument parsing, and error handling without mocking internals.

| Test | Line | What it verifies |
|---|---|---|
| --version prints version number | [L24](test/cli.test.js#L24) | Output matches `x.y.z` pattern |
| --help shows command list | [L30](test/cli.test.js#L30) | Lists all 6 commands: init, import, send, status, delete, config |
| config command prints a path | [L41](test/cli.test.js#L41) | Output contains `config.json` |
| import without --csv exits with error | [L47](test/cli.test.js#L47) | Missing required `--csv` option produces non-zero exit code |
| send without --template exits with error | [L53](test/cli.test.js#L53) | Missing required `--template` option produces non-zero exit code |
| unknown command shows error | [L59](test/cli.test.js#L59) | Unrecognized command produces non-zero exit code |

## What is NOT Tested

| Module | Reason |
|---|---|
| `src/init.js` | Heavily interactive (terminal prompts via `@clack/prompts`), calls Supabase Management API, deploys Edge Functions. Verified manually during setup. |
| ANSI/visual output | Colored text, progress bars, spinners — low value to assert on visual rendering. |
| Live API integration | All external calls are mocked. No real Resend or Supabase accounts are needed. |

## CI

Tests run automatically on every push to `main` and on every pull request via [`.github/workflows/test.yml`](.github/workflows/test.yml). The matrix covers **Node.js 18, 20, and 22**.
