/**
 * Is a deployment ready for open sign-up? Asks the running services, from outside.
 *
 *   pnpm launch:check --console https://… --api https://… [--worker https://…] [--payments]
 *
 * Without --payments it checks a free beta: no billing expected. With it, billing
 * must be on and every paid plan priced. A worker on a machine with no public address
 * cannot be checked from outside; leave --worker off and its checks are skipped.
 *
 * Read-only: GETs, and POSTs that carry no signature and must be refused. It sends
 * no credential and needs none, so it reads no .env. Every check says what it saw.
 * Exit status 1 if any required check fails.
 */

interface Check {
  name: string;
  ok: boolean;
  saw: string;
  /** Advisory checks are reported but do not fail the run. */
  advisory?: boolean;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v ? v.replace(/\/+$/, '') : null;
}

async function get(url: string, init: RequestInit = {}): Promise<{ status: number; text: string } | { error: string }> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), ...init });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { error: err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err) };
  }
}

const seen = (r: Awaited<ReturnType<typeof get>>) => ('error' in r ? `unreachable: ${r.error}` : `${r.status}`);

export async function launchChecks(urls: { console: string; api: string; worker: string | null }, opts: { payments: boolean } = { payments: false }): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, saw: string, advisory = false) => checks.push({ name, ok, saw, ...(advisory ? { advisory } : {}) });

  for (const [what, url] of Object.entries(urls)) {
    if (url) add(`${what} is served over https`, url.startsWith('https://'), url);
  }

  // ── Console ──
  const landing = await get(`${urls.console}/`);
  add('console: landing page', !('error' in landing) && landing.status === 200, seen(landing));
  const providers = await get(`${urls.console}/api/auth/providers`);
  add(
    'console: sign-in is configured (GitHub provider)',
    !('error' in providers) && providers.status === 200 && providers.text.includes('"github"'),
    'error' in providers ? seen(providers) : `${providers.status} ${providers.text.slice(0, 120)}`,
  );
  for (const page of ['/pricing', '/terms', '/privacy', '/refunds', '/contact']) {
    const r = await get(`${urls.console}${page}`);
    // Content is judged only on the page itself, never on a 404 or an error page.
    const body = !('error' in r) && r.status === 200 ? r.text : '';
    add(`console: ${page}`, !('error' in r) && r.status === 200, seen(r));
    if (page === '/contact' && !body) {
      add('console: contact page names a way to reach the operator', false, 'no contact page');
    }
    if (page === '/contact' && body) {
      const route = body.includes('mailto:') ? 'email' : /github\.com\/[^"]+\/issues/.test(body) ? 'issue tracker' : null;
      add('console: contact page names a way to reach the operator', Boolean(route), route ?? 'none');
      // Taking payments needs a named operator and a monitored address (Dodo's review).
      if (opts.payments) {
        add('console: operator name is set (PAGER_LEGAL_NAME)', !body.includes('maintainers of the Pager Developer project'), body.includes('maintainers of the Pager Developer project') ? 'unset' : 'set');
        add('console: support address is set (PAGER_SUPPORT_EMAIL)', route === 'email', route === 'email' ? 'set' : 'unset');
      }
    }
    if (page === '/pricing' && body) {
      const text = body.replace(/<!-- -->/g, '');
      if (opts.payments) {
        const price = /\$\d+(?:\.\d\d)? \/ \w+/i.exec(text)?.[0];
        add('console: pricing shows a paid plan’s price', Boolean(price), price ?? (/Price unavailable|could not be loaded/.test(text) ? 'price unavailable' : 'no price found'));
      } else {
        const loaded = !/could not be loaded/.test(text);
        add('console: pricing loads the plans from the API', loaded, loaded ? 'loaded' : 'could not be loaded');
      }
    }
  }

  // ── API ──
  const health = await get(`${urls.api}/health`);
  add('api: /health', !('error' in health) && health.status === 200, seen(health));
  const plans = await get(`${urls.api}/public/plans`);
  let billingEnabled = false;
  if (!('error' in plans) && plans.status === 200) {
    const body = JSON.parse(plans.text) as { enabled: boolean; plans: { id: string; purchasable: boolean; price: unknown }[] };
    billingEnabled = body.enabled;
    if (opts.payments) {
      add('api: billing is enabled (DODO_PAYMENTS_*)', body.enabled, String(body.enabled));
      const paid = body.plans.filter((p) => p.purchasable);
      add('api: every paid plan has a Dodo product with a price', paid.length > 0 && paid.every((p) => p.price), paid.map((p) => `${p.id}:${p.price ? 'priced' : 'no price'}`).join(', ') || 'no purchasable plan');
    } else {
      add('api: plans answer (free beta, billing not required)', true, `billing ${body.enabled ? 'on' : 'off'}`);
    }
  } else {
    add('api: /public/plans', false, seen(plans));
  }
  const anon = await get(`${urls.api}/api/billing`);
  add('api: console routes refuse an anonymous caller', !('error' in anon) && anon.status === 401, seen(anon));
  const unsigned = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
  if (billingEnabled) {
    const dodo = await get(`${urls.api}/webhooks/dodo`, unsigned);
    add('api: Dodo webhook refuses an unsigned delivery', !('error' in dodo) && dodo.status === 401, seen(dodo));
  }
  const github = await get(`${urls.api}/webhooks/github`, unsigned);
  // Refused as unsigned or unverifiable; a 404 means there is no API there at all.
  add('api: GitHub webhook refuses an unsigned delivery', !('error' in github) && [400, 401, 403].includes(github.status), seen(github));

  // ── Worker ──
  if (urls.worker) {
    const w = await get(`${urls.worker}/health`);
    let sandbox = 'unknown';
    if (!('error' in w) && w.status === 200) sandbox = (JSON.parse(w.text) as { sandbox?: string }).sandbox ?? 'not reported (an older worker)';
    add('worker: /health', !('error' in w) && w.status === 200, seen(w));
    add('worker: repository code runs in the Docker sandbox', sandbox === 'docker', sandbox);
    const slack = await get(`${urls.worker}/slack/interactions`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'payload=%7B%7D' });
    add('worker: Slack interactions refuse an unsigned request', !('error' in slack) && [400, 401, 403].includes(slack.status), seen(slack), true);
  } else {
    add('worker: not checked (no --worker; a worker on a private machine has no public URL)', false, 'skipped', true);
  }
  return checks;
}

async function main(): Promise<void> {
  const consoleUrl = arg('console');
  const api = arg('api');
  if (!consoleUrl || !api) {
    console.error('usage: pnpm launch:check --console <url> --api <url> [--worker <url>]');
    process.exit(2);
  }
  const checks = await launchChecks({ console: consoleUrl, api, worker: arg('worker') }, { payments: process.argv.includes('--payments') });
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : c.advisory ? 'WARN' : 'FAIL'}  ${c.name.padEnd(width)}  ${c.saw}`);
  const failed = checks.filter((c) => !c.ok && !c.advisory);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed${failed.length ? `; ${failed.length} must be fixed before launch` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
