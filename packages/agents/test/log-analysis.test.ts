import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@pager/providers';
import {
  assessNovelty,
  clusterErrors,
  errorSignature,
  errorType,
  firstSentences,
  parseStackTrace,
  locateInRepository,
  repositoryPathOf,
  toRepositoryPath,
} from '../src/log-analysis.js';

const APP_TRACE = `TypeError: Cannot read properties of null (reading 'percentOff')
    at CheckoutService.createOrder (/app/src/checkout/service.ts:20:52)
    at CheckoutController.postCheckout (/app/src/checkout/controller.ts:34:38)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

const VENDOR_TRACE = `PaymentGatewayError: upstream returned 503 Service Unavailable
    at PaymentsClient.request (/app/node_modules/@acme/payments-sdk/dist/client.js:212:15)
    at PaymentsClient.authorize (/app/node_modules/@acme/payments-sdk/dist/client.js:88:20)
    at processTicksAndRejections (node:internal/process/task_queues:95:5)`;

const log = (over: Partial<LogEntry> = {}): LogEntry => ({
  at: new Date('2026-09-13T14:32:00Z'),
  service: 'checkout-api',
  level: 'error',
  message: "TypeError: Cannot read properties of null (reading 'percentOff')",
  stackTrace: APP_TRACE,
  attributes: { 'http.route': 'POST /checkout' },
  ...over,
});


/** The demo repository's files, as a listing would report them. */
const REPO = new Set(['src/checkout/service.ts', 'src/server.ts', 'src/a.ts', 'handler.js']);
const inRepo = (file: string) => repositoryPathOf(file, REPO);

describe('locateInRepository', () => {
  const cluster = () =>
    clusterErrors([
      {
        at: new Date('2026-09-14T00:20:00Z'),
        service: 'checkout-api',
        level: 'error',
        message: 'TypeError: boom',
        stackTrace:
          'TypeError: boom\n' +
          '    at bundled (/app/dist/vendor.js:1:1)\n' +
          '    at CheckoutService.createOrder (/app/src/checkout/service.ts:22:60)',
        attributes: {},
      },
    ])[0]!;

  it('rewrites frames to repository paths, and a frame outside the repository is not application code', () => {
    const located = locateInRepository(cluster(), { paths: [...REPO], truncated: false });
    expect(located.frames.map((f) => [f.file, f.isDependency])).toEqual([
      ['/app/dist/vendor.js', true],
      ['src/checkout/service.ts', false],
    ]);
    expect(located.topApplicationFrame).toMatchObject({ file: 'src/checkout/service.ts', line: 22 });
  });

  it('reclassifies nothing from a partial listing', () => {
    const located = locateInRepository(cluster(), { paths: ['src/checkout/service.ts'], truncated: true });
    expect(located.frames[0]!.isDependency).toBe(false);
    expect(located.frames[1]!.file).toBe('src/checkout/service.ts');
  });
});

describe('stack trace parsing', () => {
  it('locates the failure in application code', () => {
    const frames = parseStackTrace(APP_TRACE);
    expect(frames[0]).toMatchObject({
      functionName: 'CheckoutService.createOrder',
      file: '/app/src/checkout/service.ts',
      line: 20,
      isDependency: false,
    });
  });

  it('marks dependency and runtime frames as such', () => {
    const frames = parseStackTrace(VENDOR_TRACE);
    expect(frames.every((f) => f.isDependency)).toBe(true);
  });

  it('handles frames with no function name', () => {
    const frames = parseStackTrace('    at /app/src/boot.ts:4:1');
    expect(frames[0]).toMatchObject({ functionName: null, file: '/app/src/boot.ts', line: 4 });
  });

  it('ignores lines that are not frames', () => {
    expect(parseStackTrace('TypeError: boom\n  some prose\n')).toHaveLength(0);
  });

  it('maps a runtime path to the repository file it names', () => {
    expect(inRepo('/app/src/checkout/service.ts')).toBe('src/checkout/service.ts');
    expect(inRepo('/var/task/src/a.ts')).toBe('src/a.ts');
  });
});

describe('error signatures', () => {
  it('groups occurrences that differ only in variable parts', () => {
    const a = errorSignature("Order 4471 failed for customer 'cus_abc123'");
    const b = errorSignature("Order 9902 failed for customer 'cus_zzz999'");
    expect(a).toBe(b);
  });

  it('keeps genuinely different errors apart', () => {
    expect(errorSignature('TypeError: cannot read x')).not.toBe(errorSignature('RangeError: out of range'));
  });

  it('extracts the error type', () => {
    expect(errorType('TypeError: boom')).toBe('TypeError');
    expect(errorType('PaymentGatewayError: 503')).toBe('PaymentGatewayError');
    expect(errorType('just a message')).toBeNull();
  });
});

describe('clustering', () => {
  it('collapses a thousand identical failures into one problem', () => {
    const logs = Array.from({ length: 40 }, (_, i) =>
      log({ at: new Date(Date.parse('2026-09-13T14:32:00Z') + i * 1000) }),
    );
    const clusters = clusterErrors(logs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.count).toBe(40);
    expect(clusters[0]!.firstSeen.toISOString()).toBe('2026-09-13T14:32:00.000Z');
    expect(clusters[0]!.lastSeen.toISOString()).toBe('2026-09-13T14:32:39.000Z');
  });

  it('points at the first application frame, skipping runtime internals', () => {
    const clusters = clusterErrors([log()]);
    expect(clusters[0]!.topApplicationFrame).toMatchObject({
      file: '/app/src/checkout/service.ts',
      line: 20,
    });
    expect(clusters[0]!.entirelyInDependencies).toBe(false);
  });

  it('recognises a failure that lives entirely in a dependency', () => {
    const clusters = clusterErrors([
      log({ message: 'PaymentGatewayError: upstream returned 503', stackTrace: VENDOR_TRACE }),
    ]);
    expect(clusters[0]!.entirelyInDependencies).toBe(true);
    expect(clusters[0]!.topApplicationFrame).toBeNull();
  });

  it('does not treat a missing stack trace as an upstream fault', () => {
    // No trace is an absence of evidence, not evidence the fault is external.
    const clusters = clusterErrors([log({ stackTrace: null })]);
    expect(clusters[0]!.entirelyInDependencies).toBe(false);
  });

  it('ignores non-error levels', () => {
    expect(clusterErrors([log({ level: 'info' }), log({ level: 'warn' })])).toHaveLength(0);
  });

  it('ranks distinct failures by frequency and keeps the quieter ones', () => {
    const clusters = clusterErrors([
      ...Array.from({ length: 5 }, () => log()),
      log({ message: 'RangeError: index out of range', stackTrace: null }),
    ]);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.count).toBe(5);
    expect(clusters[1]!.errorType).toBe('RangeError');
  });

  it('collects the affected routes', () => {
    const clusters = clusterErrors([
      log(),
      log({ attributes: { 'http.route': 'POST /checkout/express' } }),
    ]);
    expect(clusters[0]!.affectedRoutes.sort()).toEqual(['POST /checkout', 'POST /checkout/express']);
  });
});

describe('novelty', () => {
  const known = [
    { errorType: 'PaymentGatewayError', locations: ['@acme/payments-sdk'], messages: ['503'], description: 'Upstream gateway 503s', source: 'Runbook: checkout-api' },
  ];

  it('treats a documented failure mode as anticipated', () => {
    const cluster = clusterErrors([
      log({ message: 'PaymentGatewayError: upstream returned 503', stackTrace: VENDOR_TRACE }),
    ])[0]!;
    const verdict = assessNovelty(cluster, known);
    expect(verdict.novel).toBe(false);
    expect(verdict.reason).toMatch(/documented failure mode/);
  });

  it('treats an unrecognised failure as novel, which is what opens an incident', () => {
    const verdict = assessNovelty(clusterErrors([log()])[0]!, known);
    expect(verdict.novel).toBe(true);
    expect(verdict.matched).toBeNull();
  });

  it('does not treat a runbook that merely mentions the error type as documenting this failure', () => {
    // The old check matched any runbook line containing the type: a runbook note about
    // one TypeError silenced every TypeError the service would ever throw.
    const verdict = assessNovelty(clusterErrors([log()])[0]!, [
      { errorType: 'TypeError', locations: [], messages: [], description: 'TypeError in the legacy importer', source: 'Runbook' },
      { errorType: 'TypeError', locations: ['src/importer/legacy.ts'], messages: ['reading \'rows\''], description: 'x', source: 'Runbook' },
    ]);
    expect(verdict.novel).toBe(true);
    expect(verdict.reason).toMatch(/without a location or message specific enough/);
  });

  it('requires the same error type, not a substring of one', () => {
    const cluster = clusterErrors([log({ message: 'PaymentGatewayErrorV2: upstream returned 503', stackTrace: VENDOR_TRACE })])[0]!;
    expect(assessNovelty(cluster, known).novel).toBe(true);
  });

  it('reports novel when there are no documented modes at all', () => {
    expect(assessNovelty(clusterErrors([log()])[0]!, []).novel).toBe(true);
  });
});

/**
 * Frame shapes observed on real deployments.
 *
 * Each of these was seen in production telemetry and, before being handled,
 * produced a path that matched no file in the repository — which reads downstream
 * as "the file is not there" rather than "the frame was not understood".
 */
describe('repository paths on real runtimes', () => {
  it('removes only the scheme and the leading slash when the repository is not known', () => {
    expect(toRepositoryPath('file:///app/src/a.ts')).toBe('app/src/a.ts');
  });

  it('handles a Render container root behind a file:// URL', () => {
    expect(
      inRepo('file:///opt/render/project/src/src/checkout/service.ts'),
    ).toBe('src/checkout/service.ts');
  });

  it('handles a Render container root without a scheme', () => {
    expect(inRepo('/opt/render/project/src/src/checkout/service.ts')).toBe(
      'src/checkout/service.ts',
    );
  });

  it('derives the working directory from the repository, not from a list of platforms', () => {
    expect(inRepo('/app/src/checkout/service.ts')).toBe('src/checkout/service.ts');
    expect(inRepo('/var/task/handler.js')).toBe('handler.js');
    // A root no list would know.
    expect(inRepo('/mnt/builds/7f3a/checkout-api/src/checkout/service.ts')).toBe('src/checkout/service.ts');
    // The longest suffix wins, so a repository with its own src/src is not misread.
    expect(repositoryPathOf('/app/src/src/x.ts', new Set(['src/x.ts', 'src/src/x.ts']))).toBe('src/src/x.ts');
    expect(inRepo('/usr/lib/node/internal/timers.js')).toBeNull();
  });

  it('parses a real Render stack frame end to end', () => {
    const frames = parseStackTrace(
      `TypeError: Cannot read properties of undefined (reading 'percentOff')\n` +
        `    at CheckoutService.createOrder (file:///opt/render/project/src/src/checkout/service.ts:22:60)\n` +
        `    at Server.<anonymous> (file:///opt/render/project/src/src/server.ts:48:24)`,
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]!.isDependency).toBe(false);
    expect(inRepo(frames[0]!.file)).toBe('src/checkout/service.ts');
    expect(frames[0]!.line).toBe(22);
  });
});

/**
 * Log shapes observed on a real deployment.
 *
 * Structured JSON loggers split the error type into its own field and name the
 * route plainly. Reading only the OpenTelemetry keys reported "Error on unknown
 * route" for a log that stated both — a small untruth that then appears in the
 * ticket, the Slack message and the pull request.
 */
describe('clustering real structured logs', () => {
  const entry = (): LogEntry => ({
    at: new Date('2026-09-14T00:20:00Z'),
    service: 'checkout-api',
    level: 'error',
    message: "Cannot read properties of undefined (reading 'percentOff')",
    stackTrace:
      "TypeError: Cannot read properties of undefined (reading 'percentOff')\n" +
      '    at CheckoutService.createOrder (file:///opt/render/project/src/src/checkout/service.ts:22:60)',
    attributes: { error: 'TypeError', route: '/orders', http_status: 500 },
  });

  it('takes the error type from its own field when the message has no prefix', () => {
    expect(clusterErrors([entry()])[0]!.errorType).toBe('TypeError');
  });

  it('finds the route under a plain `route` key', () => {
    expect(clusterErrors([entry()])[0]!.affectedRoutes).toEqual(['/orders']);
  });

  it('still prefers the type stated in the message', () => {
    const log = { ...entry(), message: 'RangeError: out of bounds', attributes: { error: 'TypeError' } };
    expect(clusterErrors([log])[0]!.errorType).toBe('RangeError');
  });

  it('locates the failure in a repository file', () => {
    const frame = clusterErrors([entry()])[0]!.topApplicationFrame!;
    expect(inRepo(frame.file)).toBe('src/checkout/service.ts');
    expect(frame.line).toBe(22);
  });
});

/**
 * Information-free error entries.
 *
 * A real service mislabelled its per-request access log as error level. Those lines
 * carry no message and no stack, there is one per request, and so they outnumbered
 * the genuine failures and became the top cluster — the incident brief reported
 * "Error ×80, no application frame" for an incident that had a clear TypeError at a
 * known line. Clustering cannot depend on every log producer labelling correctly.
 */
describe('clustering ignores entries that describe no failure', () => {
  const accessLog = (): LogEntry => ({
    at: new Date('2026-09-14T00:20:00Z'),
    service: 'checkout-api',
    level: 'error',
    message: '',
    stackTrace: null,
    attributes: { route: '/orders', http_status: 500, duration_ms: 4 },
  });

  const realError = (): LogEntry => ({
    at: new Date('2026-09-14T00:20:01Z'),
    service: 'checkout-api',
    level: 'error',
    message: "Cannot read properties of undefined (reading 'percentOff')",
    stackTrace:
      "TypeError: Cannot read properties of undefined (reading 'percentOff')\n" +
      '    at CheckoutService.createOrder (file:///opt/render/project/src/src/checkout/service.ts:22:60)',
    attributes: { error: 'TypeError', route: '/orders' },
  });

  it('does not let message-less, stack-less entries become a cluster', () => {
    const clusters = clusterErrors([...Array(40)].map(accessLog));
    expect(clusters).toHaveLength(0);
  });

  it('surfaces the real failure even when swamped by them', () => {
    // The exact shape observed: 40 information-free entries against 3 real ones.
    const logs = [...[...Array(40)].map(accessLog), realError(), realError(), realError()];
    const clusters = clusterErrors(logs);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.errorType).toBe('TypeError');
    expect(clusters[0]!.count).toBe(3);
    expect(inRepo(clusters[0]!.topApplicationFrame!.file)).toBe('src/checkout/service.ts');
  });

  it('still keeps an error that has a message but no stack', () => {
    // Absence of a stack is not absence of information.
    const log = { ...accessLog(), message: 'Upstream refused the connection' };
    expect(clusterErrors([log])).toHaveLength(1);
  });
});

describe('firstSentences', () => {
  it('keeps short text whole', () => {
    expect(firstSentences('One sentence only.', 2)).toBe('One sentence only.');
  });

  it('truncates long prose and marks that it did', () => {
    // Silent truncation is the failure mode: a reader must be able to tell they
    // are seeing part of something.
    const out = firstSentences('First. Second. Third. Fourth.', 2);
    expect(out).toBe('First. Second. …');
  });

  it('collapses the newlines model prose is full of', () => {
    expect(firstSentences('A.\n\n   B.\nC.', 2)).toBe('A. B. …');
  });

  it('does not choke on text with no sentence endings', () => {
    expect(firstSentences('no punctuation here', 2)).toBe('no punctuation here');
  });
});
