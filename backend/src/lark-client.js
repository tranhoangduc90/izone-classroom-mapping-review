const API_ROOT = 'https://open.larksuite.com/open-apis';
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class LarkClient {
  constructor({ appId, appSecret, baseAppToken, fetchImpl = fetch }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.baseAppToken = baseAppToken;
    this.fetchImpl = fetchImpl;
    this.cachedToken = null;
    this.nextWriteAt = 0;
  }

  async token() {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 300_000) {
      return this.cachedToken.value;
    }
    const response = await this.fetchImpl(`${API_ROOT}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const payload = await response.json();
    if (!response.ok || Number(payload?.code ?? 0) !== 0 || !payload?.tenant_access_token) {
      throw new Error(`LARK_AUTH_FAILED:${payload?.code ?? response.status}`);
    }
    const expiresIn = Number(payload.expire ?? payload.expire_in ?? 7_200);
    this.cachedToken = {
      value: payload.tenant_access_token,
      expiresAt: now + Math.max(60, expiresIn) * 1_000,
    };
    return this.cachedToken.value;
  }

  async request(method, pathname, { query, body, write = false, retry = true } = {}) {
    if (write) await this.waitForWriteSlot();
    const url = new URL(`${API_ROOT}/bitable/v1/apps/${this.baseAppToken}${pathname}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    let lastCode = 'UNKNOWN';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      const token = await this.token();
      let response;
      let payload;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json; charset=utf-8',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const raw = await response.text();
        payload = raw ? JSON.parse(raw) : {};
      } catch (error) {
        lastCode = 'NETWORK';
        if (!retry || attempt >= RETRY_DELAYS_MS.length) throw new Error('LARK_NETWORK_FAILED');
        await sleep(RETRY_DELAYS_MS[attempt]);
        continue;
      }

      const apiCode = Number(payload?.code ?? 0);
      if (response.ok && apiCode === 0) return payload?.data ?? {};

      lastCode = String(apiCode || response.status);
      const retryable = response.status === 429
        || response.status >= 500
        || apiCode === 99991400;
      if (!retry || !retryable || attempt >= RETRY_DELAYS_MS.length) {
        throw new Error(`LARK_API_FAILED:${lastCode}`);
      }
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
    throw new Error(`LARK_API_FAILED:${lastCode}`);
  }

  async waitForWriteSlot() {
    const now = Date.now();
    if (this.nextWriteAt > now) await sleep(this.nextWriteAt - now);
    this.nextWriteAt = Date.now() + 500;
  }

  async listTables() {
    const items = [];
    let pageToken = '';
    do {
      const data = await this.request('GET', '/tables', {
        query: { page_size: 100, page_token: pageToken },
      });
      items.push(...(data.items ?? []));
      pageToken = data.has_more ? String(data.page_token ?? '') : '';
    } while (pageToken);
    return items;
  }

  async createTable(name, fields) {
    const data = await this.request('POST', '/tables', {
      write: true,
      body: {
        table: {
          name,
          default_view_name: 'Tất cả dữ liệu',
          fields: fields.map((field) => ({
            field_name: field.name,
            type: field.type,
            ...(field.property ? { property: field.property } : {}),
          })),
        },
      },
    });
    return data.table ?? {
      table_id: data.table_id,
      name,
    };
  }

  async deleteTable(tableId) {
    await this.request('DELETE', `/tables/${tableId}`, { write: true });
  }

  async listFields(tableId) {
    const items = [];
    let pageToken = '';
    do {
      const data = await this.request('GET', `/tables/${tableId}/fields`, {
        query: { page_size: 100, page_token: pageToken },
      });
      items.push(...(data.items ?? []));
      pageToken = data.has_more ? String(data.page_token ?? '') : '';
    } while (pageToken);
    return items;
  }

  async listRecords(tableId) {
    const items = [];
    let pageToken = '';
    do {
      const data = await this.request('GET', `/tables/${tableId}/records`, {
        query: { page_size: 500, page_token: pageToken },
      });
      items.push(...(data.items ?? []));
      pageToken = data.has_more ? String(data.page_token ?? '') : '';
    } while (pageToken);
    return items;
  }

  async createRecords(tableId, records) {
    return this.request('POST', `/tables/${tableId}/records/batch_create`, {
      write: true,
      body: { records },
    });
  }

  async updateRecords(tableId, records) {
    return this.request('POST', `/tables/${tableId}/records/batch_update`, {
      write: true,
      body: { records },
    });
  }
}
