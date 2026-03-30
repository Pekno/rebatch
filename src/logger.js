import ora from 'ora';
import gradient from 'gradient-string';
import boxen from 'boxen';

// ---------------------------------------------------------------------------
// JSON mode — when enabled, all output is structured JSON to stdout.
// ---------------------------------------------------------------------------
let jsonMode = false;
const jsonBuffer = [];

export function setJsonMode(enabled) {
  jsonMode = enabled;
}

export function isJsonMode() {
  return jsonMode;
}

export function jsonPush(type, data) {
  if (jsonMode) jsonBuffer.push({ type, ...data });
}

export function jsonFlush() {
  if (jsonMode && jsonBuffer.length > 0) {
    console.log(JSON.stringify(jsonBuffer.length === 1 ? jsonBuffer[0] : jsonBuffer, null, 2));
    jsonBuffer.length = 0;
  }
}

export function jsonOut(data) {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Colors & symbols
// ---------------------------------------------------------------------------
const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bgGreen: '\x1b[42m',
  bgWhite: '\x1b[47m',
};

const SYMBOLS = {
  check: process.platform === 'win32' ? '\u221A' : '\u2714',
  cross: process.platform === 'win32' ? '\u00D7' : '\u2716',
  arrow: process.platform === 'win32' ? '>' : '\u25B8',
  bullet: process.platform === 'win32' ? '*' : '\u25CF',
};

// ---------------------------------------------------------------------------
// ASCII banner with gradient
// ---------------------------------------------------------------------------
const BANNER = `
                __          __       __
   ________   / /_  ____ _/ /______/ /_
  / ___/ _ \\ / __ \\/ __ \`/ __/ ___/ __ \\
 / /  /  __// /_/ / /_/ / /_/ /__/ / / /
/_/   \\___//_.___/\\__,_/\\__/\\___/_/ /_/
`;

const rebatchGradient = gradient(['#6366f1', '#8b5cf6', '#d946ef', '#ec4899']);

export function showBanner() {
  if (jsonMode) return;
  console.log(rebatchGradient(BANNER));
  console.log(`  ${COLORS.dim}Bulk email sender via Resend Broadcast API${COLORS.reset}\n`);
}

// ---------------------------------------------------------------------------
// Logging functions
// ---------------------------------------------------------------------------
function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${rm}m`;
}

export function info(msg) {
  if (jsonMode) return;
  console.log(`${COLORS.dim}[${timestamp()}]${COLORS.reset} ${msg}`);
}

export function success(msg) {
  if (jsonMode) return;
  console.log(`${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.green}${SYMBOLS.check} ${msg}${COLORS.reset}`);
}

export function warn(msg) {
  if (jsonMode) return;
  console.log(`${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.yellow}${msg}${COLORS.reset}`);
}

export function error(msg) {
  if (jsonMode) {
    jsonOut({ type: 'error', message: msg });
    return;
  }
  console.error(`${COLORS.dim}[${timestamp()}]${COLORS.reset} ${COLORS.red}${SYMBOLS.cross} ${msg}${COLORS.reset}`);
}

export function header(msg) {
  if (jsonMode) return;
  const line = '\u2500'.repeat(Math.max(msg.length + 4, 50));
  console.log(`\n${COLORS.cyan}${line}${COLORS.reset}`);
  console.log(`${COLORS.cyan}  ${COLORS.bold}${msg}${COLORS.reset}`);
  console.log(`${COLORS.cyan}${line}${COLORS.reset}\n`);
}

export function keyValue(key, value) {
  if (jsonMode) return;
  console.log(`  ${COLORS.dim}${key.padEnd(16)}${COLORS.reset} ${value}`);
}

// ---------------------------------------------------------------------------
// Ora spinner wrapper
// ---------------------------------------------------------------------------
export function spinner(text) {
  if (jsonMode) {
    return { succeed: () => {}, fail: () => {}, stop: () => {}, update: () => {} };
  }
  return ora({ text, spinner: 'dots', indent: 2 });
}

// ---------------------------------------------------------------------------
// Summary box (used after send completes)
// ---------------------------------------------------------------------------
export function summaryBox(title, lines) {
  if (jsonMode) return;
  const content = lines.join('\n');
  console.log(
    boxen(content, {
      title,
      titleAlignment: 'center',
      padding: 1,
      margin: { top: 1, bottom: 1, left: 2, right: 2 },
      borderStyle: 'round',
      borderColor: 'magenta',
    })
  );
}

// ---------------------------------------------------------------------------
// Progress bar that overwrites the current line in the terminal.
// ---------------------------------------------------------------------------
export class ProgressBar {
  constructor({ total, label = '', width = 30 }) {
    this.total = total;
    this.current = 0;
    this.label = label;
    this.width = width;
    this.startTime = Date.now();
    this.spinIdx = 0;
  }

  tick(status = '') {
    this.current++;
    this.render(status);
  }

  update(status = '') {
    this.render(status);
  }

  render(status) {
    if (jsonMode) return;
    const pct = Math.min(this.current / this.total, 1);
    const filled = Math.round(this.width * pct);
    const empty = this.width - filled;
    const bar = `${COLORS.green}${'\u2588'.repeat(filled)}${COLORS.dim}${'\u2591'.repeat(empty)}${COLORS.reset}`;
    const pctStr = `${Math.round(pct * 100)}%`.padStart(4);
    const counter = `${this.current}/${this.total}`;
    const elapsed = formatDuration(Date.now() - this.startTime);

    const spinnerFrames = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

    const eta = pct > 0 && pct < 1
      ? formatDuration(((Date.now() - this.startTime) / pct) * (1 - pct))
      : '';

    const spin = pct < 1 ? spinnerFrames[this.spinIdx++ % spinnerFrames.length] + ' ' : '';
    const etaStr = eta ? ` ${COLORS.dim}ETA ${eta}${COLORS.reset}` : '';
    const statusStr = status ? ` ${COLORS.dim}${status}${COLORS.reset}` : '';

    const line = `  ${spin}${this.label} ${bar} ${pctStr} ${COLORS.dim}(${counter} | ${elapsed})${COLORS.reset}${etaStr}${statusStr}`;

    process.stdout.write(`\r\x1b[K${line}`);

    if (pct >= 1) {
      process.stdout.write('\n');
    }
  }

  stop(status = '') {
    if (this.current < this.total) {
      this.current = this.total;
      this.render(status);
    }
  }
}

// ---------------------------------------------------------------------------
// Step display
// ---------------------------------------------------------------------------
const STEPS = ['Adding contacts', 'Creating broadcast', 'Sending broadcast', 'Awaiting delivery', 'Removing contacts', 'Updating database'];

export function stepStart(stepIndex) {
  if (jsonMode) return;
  const name = STEPS[stepIndex] || `Step ${stepIndex + 1}`;
  process.stdout.write(`  ${COLORS.cyan}${SYMBOLS.arrow}${COLORS.reset} ${name}...`);
}

export function stepDone(stepIndex) {
  if (jsonMode) return;
  const name = STEPS[stepIndex] || `Step ${stepIndex + 1}`;
  process.stdout.write(`\r\x1b[K  ${COLORS.green}${SYMBOLS.check}${COLORS.reset} ${name}\n`);
}

export function stepFail(stepIndex) {
  if (jsonMode) return;
  const name = STEPS[stepIndex] || `Step ${stepIndex + 1}`;
  process.stdout.write(`\r\x1b[K  ${COLORS.red}${SYMBOLS.cross}${COLORS.reset} ${name}\n`);
}
