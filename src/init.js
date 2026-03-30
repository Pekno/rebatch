import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import JSZip from 'jszip';
import * as p from '@clack/prompts';
import { getEdgeFunctionSource } from './edge-function.js';
import * as log from './logger.js';

const SUPABASE_API = 'https://api.supabase.com';

export function getConfigDir() {
  const plat = platform();
  if (plat === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'rebatch');
  if (plat === 'darwin') return join(homedir(), 'Library', 'Application Support', 'rebatch');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'rebatch');
}

export function getConfigPath() {
  return join(getConfigDir(), 'config.json');
}

const EMAIL_RECIPIENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS email_recipients (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  first_name TEXT,
  last_name TEXT,
  organization TEXT,
  group_names TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'failed', 'sent', 'already_contacted', 'unsubscribed')),
  unsubscribe_token UUID DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_email_recipients_status ON email_recipients(status);
CREATE INDEX IF NOT EXISTS idx_email_recipients_group_names ON email_recipients USING GIN(group_names);
`;

async function supabaseApi(path, accessToken, options = {}) {
  const res = await fetch(`${SUPABASE_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      ...options.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase API ${path} failed (${res.status}): ${text}`);
  }
  return res;
}

async function listProjects(accessToken) {
  const res = await supabaseApi('/v1/projects', accessToken);
  return res.json();
}

async function getApiKeys(accessToken, projectRef) {
  const res = await supabaseApi(`/v1/projects/${projectRef}/api-keys?reveal=true`, accessToken);
  return res.json();
}

async function ensureSchema(supabaseUrl, supabaseServiceKey) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { error } = await supabase
    .from('email_recipients')
    .select('id')
    .limit(1);

  if (!error) {
    log.success('Supabase table "email_recipients" already exists');
    return;
  }

  log.info('Creating "email_recipients" table in Supabase...');

  const sqlRes = await fetch(`${supabaseUrl}/pg/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseServiceKey,
      'Authorization': `Bearer ${supabaseServiceKey}`,
    },
    body: JSON.stringify({ query: EMAIL_RECIPIENTS_SCHEMA }),
  });

  if (!sqlRes.ok) {
    const fallbackRes = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': supabaseServiceKey,
        'Authorization': `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({ sql: EMAIL_RECIPIENTS_SCHEMA }),
    });

    if (!fallbackRes.ok) {
      log.warn('Could not auto-create the table. Please run the following SQL in your Supabase SQL Editor:\n');
      console.log(EMAIL_RECIPIENTS_SCHEMA);
      return;
    }
  }

  log.success('Supabase table "email_recipients" created successfully');
}

async function deployUnsubscribeFunction(accessToken, projectRef) {
  const s = log.spinner('Deploying unsubscribe Edge Function...');
  s.start();

  const source = getEdgeFunctionSource();

  const zip = new JSZip();
  zip.file('index.ts', source);
  const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

  const metadata = JSON.stringify({
    name: 'unsubscribe',
    entrypoint_path: 'index.ts',
    verify_jwt: false,
  });

  const form = new FormData();
  form.append('metadata', new Blob([metadata], { type: 'application/json' }), 'metadata.json');
  form.append('file', new Blob([zipBuffer], { type: 'application/zip' }), 'function.zip');

  try {
    await supabaseApi(`/v1/projects/${projectRef}/functions/deploy`, accessToken, {
      method: 'POST',
      body: form,
    });

    const functionUrl = `https://${projectRef}.supabase.co/functions/v1/unsubscribe`;
    s.succeed(`Edge Function deployed: ${functionUrl}`);
    return functionUrl;
  } catch (err) {
    s.fail(`Could not auto-deploy the Edge Function: ${err.message}`);
    log.info('You can deploy it manually using the Supabase CLI or Dashboard.');
    log.info('The function source is in: src/edge-function.js');
    return null;
  }
}

function cancelled() {
  p.cancel('Setup cancelled.');
  process.exit(0);
}

export async function runInit() {
  log.showBanner();

  p.intro('rebatch init');

  const configDir = getConfigDir();
  const configPath = getConfigPath();

  if (existsSync(configPath)) {
    const overwrite = await p.confirm({
      message: 'Config already exists. Overwrite?',
      initialValue: false,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      cancelled();
      return;
    }
  }

  // --- Resend config ---
  const resend = await p.group({
    resendApiKey: () => p.text({
      message: 'Resend API key',
      placeholder: 're_...',
      validate: (v) => v.length === 0 ? 'Required' : undefined,
    }),
    segmentId: () => p.text({
      message: 'Resend segment/audience ID',
      validate: (v) => v.length === 0 ? 'Required' : undefined,
    }),
  }, { onCancel: cancelled });

  // --- Supabase config ---
  const supabaseAccessToken = await p.text({
    message: 'Supabase access token',
    placeholder: 'dashboard.supabase.com > Account > Access Tokens',
    validate: (v) => v.length === 0 ? 'Required' : undefined,
  });
  if (p.isCancel(supabaseAccessToken)) return cancelled();

  const s = log.spinner('Fetching your Supabase projects...');
  s.start();
  let projects;
  try {
    projects = await listProjects(supabaseAccessToken);
  } catch (err) {
    s.fail(`Failed to fetch projects: ${err.message}`);
    p.outro('Check that your access token is correct.');
    return;
  }

  if (!projects.length) {
    s.fail('No Supabase projects found for this account.');
    return;
  }
  s.succeed(`Found ${projects.length} project(s)`);

  const projectRef = await p.select({
    message: 'Select a Supabase project',
    options: projects.map((proj) => ({
      value: proj.id,
      label: proj.name,
      hint: `${proj.id} \u2014 ${proj.region}`,
    })),
  });
  if (p.isCancel(projectRef)) return cancelled();

  const project = projects.find((proj) => proj.id === projectRef);
  const supabaseUrl = `https://${projectRef}.supabase.co`;

  // Fetch API keys
  const s2 = log.spinner('Fetching project API keys...');
  s2.start();
  let supabaseServiceKey;
  try {
    const keys = await getApiKeys(supabaseAccessToken, projectRef);
    const serviceKey = keys.find((k) => k.name === 'service_role');
    if (!serviceKey) {
      s2.fail('Could not find service_role key in API response.');
      return;
    }
    supabaseServiceKey = serviceKey.api_key;
    s2.succeed('API keys retrieved');
  } catch (err) {
    s2.fail(`Failed to fetch API keys: ${err.message}`);
    return;
  }

  // --- Email config ---
  const email = await p.group({
    fromEmail: () => p.text({
      message: 'From email',
      placeholder: 'Name <you@example.com>',
      validate: (v) => v.length === 0 ? 'Required' : undefined,
    }),
    replyTo: ({ results }) => p.text({
      message: 'Reply-to email',
      defaultValue: results.fromEmail?.match(/<(.+)>/)?.[1] || results.fromEmail,
    }),
  }, { onCancel: cancelled });

  // --- Build config ---
  const config = {
    resendApiKey: resend.resendApiKey,
    segmentId: resend.segmentId,
    supabaseAccessToken,
    supabaseUrl,
    supabaseServiceKey,
    fromEmail: email.fromEmail,
    replyTo: email.replyTo,
    batchSize: 100,
    pollIntervalMs: 5000,
    pollTimeoutMs: 300000,
    rateLimitDelayMs: 600,
    csvColumns: {
      email: 'email',
      firstName: 'firstname',
      lastName: 'lastname',
      organization: 'organization',
    },
  };

  // Write config
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  log.success(`Config written to ${configPath}`);

  // Setup Supabase schema
  console.log('');
  await ensureSchema(supabaseUrl, supabaseServiceKey);

  // Deploy unsubscribe Edge Function
  console.log('');
  const functionUrl = await deployUnsubscribeFunction(supabaseAccessToken, projectRef);

  // Done
  const nextSteps = [
    '1. Create an email template in Resend',
    functionUrl
      ? `2. Add unsubscribe link to your template:\n   <a href="${functionUrl}?token={{{contact.unsubscribe_token}}}">Unsubscribe</a>`
      : '2. Deploy the unsubscribe Edge Function manually, then add the unsubscribe link',
    '3. Run: rebatch import <group> --csv <path>',
    '4. Run: rebatch send <group> --template <name>',
  ];

  p.note(nextSteps.join('\n'), 'Next steps');
  p.outro('Setup complete!');
}
