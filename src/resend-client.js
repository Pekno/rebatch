import * as log from './logger.js';

const BASE_URL = 'https://api.resend.com';
const MAX_RETRIES = 5;

export class ResendClient {
  constructor(apiKey, rateLimitDelayMs = 600) {
    this.apiKey = apiKey;
    this.rateLimitDelayMs = rateLimitDelayMs;
  }

  async request(method, path, body = null) {
    const url = `${BASE_URL}${path}`;
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      // Wait between requests to respect Resend's 2 req/s rate limit
      await this.delay(this.rateLimitDelayMs);

      let res;
      try {
        res = await fetch(url, options);
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err;
        log.warn(`Network error on ${method} ${path}, retrying (${attempt}/${MAX_RETRIES})...`);
        await this.delay(2000 * attempt);
        continue;
      }

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : this.rateLimitDelayMs * attempt;
        log.warn(`Rate limited (429), waiting ${waitMs}ms before retry (${attempt}/${MAX_RETRIES})...`);
        await this.delay(waitMs);
        continue;
      }

      if (res.status >= 500) {
        if (attempt === MAX_RETRIES) {
          const text = await res.text();
          throw new Error(`Server error ${res.status} on ${method} ${path}: ${text}`);
        }
        log.warn(`Server error ${res.status}, retrying (${attempt}/${MAX_RETRIES})...`);
        await this.delay(2000 * attempt);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error ${res.status} on ${method} ${path}: ${text}`);
      }

      // DELETE may return 204 with no body
      if (res.status === 204) return null;

      return res.json();
    }
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- Contacts ---

  async addContact(segmentId, { email, firstName, lastName, properties }) {
    return this.request('POST', '/contacts', {
      email,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
      unsubscribed: false,
      segments: [{ id: segmentId }],
      ...(properties && Object.keys(properties).length > 0 && { properties }),
    });
  }

  async listContacts() {
    const result = await this.request('GET', '/contacts');
    return result?.data || [];
  }

  async removeContact(contactId) {
    return this.request('DELETE', `/contacts/${contactId}`);
  }

  // --- Templates ---

  async listTemplates() {
    const result = await this.request('GET', '/templates');
    return result?.data || [];
  }

  async getTemplate(templateId) {
    return this.request('GET', `/templates/${templateId}`);
  }

  async getTemplateByName(name) {
    const templates = await this.listTemplates();
    const match = templates.find((t) => t.name === name);
    if (!match) {
      const available = templates.map((t) => t.name).join(', ');
      throw new Error(`Template "${name}" not found on Resend. Available: ${available || 'none'}`);
    }
    const full = await this.getTemplate(match.id);
    return full;
  }

  // --- Broadcasts ---

  async createBroadcast({ segmentId, from, replyTo, subject, html, name }) {
    return this.request('POST', '/broadcasts', {
      segment_id: segmentId,
      from,
      reply_to: replyTo,
      subject,
      html,
      name,
    });
  }

  async sendBroadcast(broadcastId) {
    return this.request('POST', `/broadcasts/${broadcastId}/send`);
  }

  async getBroadcast(broadcastId) {
    return this.request('GET', `/broadcasts/${broadcastId}`);
  }
}
