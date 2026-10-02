import { describe, expect, it } from 'vitest';
import { clusterErrors, parsePythonTraceback, parseStackTrace, repositoryPathOf } from '../src/log-analysis.js';
import { importedModules } from '../src/workflow.js';

const TRACEBACK = `Traceback (most recent call last):
  File "/usr/lib/python3.12/site-packages/flask/app.py", line 1473, in wsgi_app
    response = self.full_dispatch_request()
  File "/srv/app/billing/api.py", line 22, in create_invoice
    return service.invoice(payload)
  File "/srv/app/billing/service.py", line 41, in invoice
    rate = TAX_RATES[order["region"]]
KeyError: 'eu-west'`;

describe('Python tracebacks', () => {
  it('parses frames innermost first, like a V8 trace, so the top application frame is where it failed', () => {
    const frames = parsePythonTraceback(TRACEBACK);
    expect(frames.map((f) => [f.file, f.line, f.functionName, f.isDependency])).toEqual([
      ['/srv/app/billing/service.py', 41, 'invoice', false],
      ['/srv/app/billing/api.py', 22, 'create_invoice', false],
      ['/usr/lib/python3.12/site-packages/flask/app.py', 1473, 'wsgi_app', true],
    ]);
    expect(parseStackTrace(TRACEBACK)).toEqual(frames);
  });

  it('clusters a Python error log, taking the type from the end of the traceback', () => {
    const [cluster] = clusterErrors([
      { at: new Date(), service: 'billing-api', level: 'error', message: 'invoice failed', stackTrace: TRACEBACK, attributes: { route: '/invoices' } },
    ]);
    expect(cluster).toMatchObject({ errorType: 'KeyError', affectedRoutes: ['/invoices'] });
    expect(repositoryPathOf(cluster!.topApplicationFrame!.file, new Set(['billing/service.py']))).toBe('billing/service.py');
  });
});

describe('import discovery', () => {
  it('follows Python relative and absolute imports, from the root and from src/', () => {
    const content = 'from .pricing import tax_for\nfrom billing.models import Order\nimport billing.util, json\nfrom ..shared.money import cents\n';
    expect(importedModules('billing/api/service.py', content)).toEqual([
      ['billing/api/pricing.py', 'billing/api/pricing/__init__.py'],
      ['billing/models.py', 'billing/models/__init__.py', 'src/billing/models.py', 'src/billing/models/__init__.py'],
      ['shared/money.py', 'shared/money/__init__.py'].map((p) => `billing/${p}`),
      ['billing/util.py', 'billing/util/__init__.py', 'src/billing/util.py', 'src/billing/util/__init__.py'],
      ['json.py', 'json/__init__.py', 'src/json.py', 'src/json/__init__.py'],
    ]);
  });

  it('follows CommonJS requires and bare ES imports, not only `from` imports', () => {
    const content = "const db = require('./db');\nimport './polyfills.js';\nimport express from 'express';\nimport { a } from '../lib/a.ts';\n";
    expect(importedModules('src/routes/orders.js', content)).toEqual([
      ['src/routes/polyfills.js', 'src/routes/polyfills.ts'],
      ['src/lib/a.ts', 'src/lib/a.ts'],
      ['src/routes/db.ts', 'src/routes/db.js', 'src/routes/db/index.ts', 'src/routes/db/index.js', 'src/routes/db'],
    ]);
  });
});
