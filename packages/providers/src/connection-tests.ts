import { Http, ProviderHttpError } from './http.js';

/**
 * "Test connection", per integration.
 *
 * Each makes one real call with the credentials as stored, against the vendor's own
 * API, and reports what the vendor said. A test that passes proves the credential
 * works for the call the product will make — not merely that it has the right shape.
 */

export type ConnectionResult = { ok: true; detail: string } | { ok: false; error: string };

function failed(err: unknown): ConnectionResult {
  if (err instanceof ProviderHttpError) {
    if (err.status === 401 || err.status === 403) return { ok: false, error: `the vendor refused the credential (${err.status})` };
    return { ok: false, error: `the vendor answered ${err.status}` };
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** Datadog needs both keys: the API key alone validates, but every read needs the app key too. */
export async function testDatadog(
  input: { site: string; apiKey: string; appKey: string },
  fetchImpl?: typeof globalThis.fetch,
): Promise<ConnectionResult> {
  const http = new Http({
    baseUrl: input.site,
    headers: { 'dd-api-key': input.apiKey, 'dd-application-key': input.appKey },
    retries: 0,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  try {
    const valid = await http.get<{ valid?: boolean }>('/api/v1/validate');
    if (!valid.valid) return { ok: false, error: 'Datadog says the API key is not valid' };
    await http.get('/api/v1/monitor', { page_size: 1 });
    return { ok: true, detail: 'API key valid; application key can read monitors' };
  } catch (err) {
    return failed(err);
  }
}

export async function testNotion(input: { baseUrl?: string; token: string }, fetchImpl?: typeof globalThis.fetch): Promise<ConnectionResult> {
  const http = new Http({
    baseUrl: input.baseUrl ?? 'https://api.notion.com',
    headers: { authorization: `Bearer ${input.token}`, 'notion-version': '2022-06-28' },
    retries: 0,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  try {
    const me = await http.get<{ name?: string; type?: string }>('/v1/users/me');
    return { ok: true, detail: `connected as ${me.name ?? me.type ?? 'the integration'}` };
  } catch (err) {
    return failed(err);
  }
}

export async function testResend(input: { baseUrl?: string; apiKey: string }, fetchImpl?: typeof globalThis.fetch): Promise<ConnectionResult> {
  const http = new Http({
    baseUrl: input.baseUrl ?? 'https://api.resend.com',
    headers: { authorization: `Bearer ${input.apiKey}` },
    retries: 0,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  try {
    const domains = await http.get<{ data?: unknown[] }>('/domains');
    return { ok: true, detail: `${domains.data?.length ?? 0} sending domain(s)` };
  } catch (err) {
    return failed(err);
  }
}

export async function testAnthropic(input: { baseUrl?: string; apiKey: string }, fetchImpl?: typeof globalThis.fetch): Promise<ConnectionResult> {
  const http = new Http({
    baseUrl: input.baseUrl ?? 'https://api.anthropic.com',
    headers: { 'x-api-key': input.apiKey, 'anthropic-version': '2023-06-01' },
    retries: 0,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  try {
    const models = await http.get<{ data?: unknown[] }>('/v1/models', { limit: 1 });
    return { ok: true, detail: `key accepted (${models.data?.length ?? 0} model listed)` };
  } catch (err) {
    return failed(err);
  }
}
