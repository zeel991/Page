import Link from 'next/link';
import { CountUp } from '@/components/motion/count-up';
import { CopyButton } from '@/components/motion/copy-button';
import { DitherIncident, DitherPager } from '@/components/motion/dither';
import { MagneticScroll } from '@/components/motion/magnetic-scroll';
import { Reveal } from '@/components/motion/reveal';
import { ScrambleText } from '@/components/motion/scramble-text';
import { ShapeGrid } from '@/components/motion/shape-grid';
import { Barcode, CircleLink, Marquee, SectionLabel, Wordmark } from '@/components/site/primitives';

/*
 * The public face of the project.
 *
 * Every figure on this page is one the README already reports, from one measured
 * incident. Nothing here is a projection, an aggregate across customers, or a
 * number that would need a caveat the page does not carry.
 */

const LINKS = {
  demo: 'https://youtu.be/2Bos0VkR3jg',
  live: 'https://pager-developer-worker.onrender.com',
  repo: 'https://github.com/zeel991/Page',
  postmortem:
    'https://app.notion.com/p/INC-E505D848ED42-checkout-api-incident-write-up-3da562d1750581ed87bdd3c1d6203be0',
  prs: [5, 9, 12].map((n) => ({ n, url: `https://github.com/he11world/test/pull/${n}` })),
};

const NAV = [
  ['Guarantees', '#guarantees'],
  ['Numbers', '#numbers'],
  ['The loop', '#loop'],
  ['Run it', '#run'],
] as const;

const GUARANTEES = [
  {
    title: 'Cited evidence',
    body: 'A tool-call id is minted only after a call really executes, and it is the only thing a finding may cite. The database enforces it too — a model cannot fabricate evidence, because it cannot fabricate an id the recorder never issued.',
    chip: 'evidence.source_tool_call_id NOT NULL',
  },
  {
    title: 'Exit codes',
    body: 'A check has passed only when a command exited zero. A skipped check is not a passing check. Unparseable test output yields null counts, never 0 — "0 failed" and "we could not tell" must never look alike.',
    chip: 'exit 0 · counts: null ≠ 0',
  },
  {
    title: 'Fail, then pass',
    body: 'Reproduction requires a regression test that fails before the patch — on a failing assertion the author predicted in advance — and passes after it. A syntax error, a missing module or an already-red suite are each refused by name.',
    chip: 'before: exit 1 → after: exit 0',
  },
  {
    title: 'No blame without proof',
    body: 'The regression detector has no field in which to record deployment blame. Attribution is a separate verdict requiring its own evidence, and until one exists the incident reads NOT DETERMINED everywhere it appears.',
    chip: 'attribution: NOT DETERMINED',
  },
];

const STEPS = [
  ['Read the deployed revision', 'From the service itself, never assumed.'],
  ['Is this failure novel?', 'Runbooks say what is already known.'],
  ['Investigate', 'A bounded read-tool loop with cited findings.'],
  ['Reproduce it', 'Must FAIL, for the predicted reason.'],
  ['Write the patch', 'Then the test must PASS.'],
  ['Validate', 'Real processes, real exit codes.'],
  ['Open the pull request', 'Evidence attached, a merge button in Slack.'],
] as const;

const AFTER_MERGE = [
  ['Verify recovery', 'Metrics either side of the merge.'],
  ['File the postmortem', 'To Notion, with measured impact.'],
  ['Mail the team', 'The subject changes if recovery is unverified.'],
] as const;

const REFUSALS = [
  ['NOT DETERMINED', 'Asked to blame a deployment, it found the same errors in the baseline before that deploy existed — and declined to attribute.'],
  ['STALE TELEMETRY', 'If the evidence window does not reach the present, it says so instead of fixing yesterday’s bug.'],
  ['UNVERIFIABLE', 'It will not claim a recovery it did not measure. The postmortem is still filed, and the incident stays open for a human.'],
  ['EVIDENCE PROTECTED', 'A patch naming the regression test is rejected twice — by the generator, and again by the layer that writes to disk.'],
  ['REVISION MISMATCH', 'It will not validate against a branch head in place of the deployed revision. It halts instead.'],
] as const;

const ADAPTERS = ['GitHub', 'Datadog', 'Slack', 'Notion', 'Jira', 'Linear', 'Resend'];

const QUICKSTART = `pnpm install
pnpm demo:workflow     # alert to team email, offline
pnpm api:seed && pnpm api
pnpm --filter @pager/web dev`;

export default function LandingPage() {
  return (
    <div id="top" className="overflow-x-clip bg-paper text-carbon">
      <MagneticScroll />
      {/* ─────────────────────────────── HERO ─────────────────────────────── */}
      <section data-snap className="relative overflow-hidden bg-signal text-paper">
        <div className="mx-auto flex max-w-[1440px] flex-col px-5 pb-8 md:min-h-[100svh] md:px-10">
          <header className="flex items-center justify-between py-6">
            <Wordmark />
            <nav className="hidden items-center gap-8 md:flex">
              {NAV.map(([label, href]) => (
                <a key={href} href={href} className="eyebrow opacity-80 transition-opacity hover:opacity-100">
                  {label}
                </a>
              ))}
              <Link href="/signin" className="eyebrow rounded-full border border-paper/60 px-4 py-2 hover:bg-paper hover:text-signal">
                Sign up
              </Link>
            </nav>
            <details className="relative md:hidden">
              <summary className="eyebrow flex cursor-pointer list-none items-center gap-3">
                Menu
                <span className="flex w-10 flex-col gap-[3px]" aria-hidden>
                  <span className="h-px bg-current" />
                  <span className="h-px bg-current" />
                </span>
              </summary>
              <div className="absolute right-0 z-20 mt-3 w-48 rounded-md bg-carbon p-2 text-paper shadow-xl">
                {[...NAV, ['Sign up', '/signin'] as const].map(([label, href]) => (
                  <a key={href} href={href} className="eyebrow block rounded px-3 py-2 hover:bg-graphite">
                    {label}
                  </a>
                ))}
              </div>
            </details>
          </header>

          <h1 className="sr-only">Pager Developer — an AI production engineer that holds the pager</h1>

          <div aria-hidden className="display animate-rise pt-4 text-[clamp(84px,21vw,330px)] md:pt-2">
            Pager
          </div>

          <div className="relative z-10 mt-4 grid grid-cols-12 items-center gap-5 md:-my-10">
            <p className="eyebrow col-span-12 max-w-[290px] text-[12px] leading-[1.5] md:col-span-3">
              An AI production engineer that holds the pager. It watches real deployments, investigates real
              failures, proves a fix — and hands a human the pull request.
            </p>
            <div className="col-span-7 md:col-span-4 md:col-start-5">
              <div className="aspect-square w-full max-w-[340px] overflow-hidden shadow-[0_30px_60px_-20px_rgba(0,0,0,0.45)]">
                <DitherPager />
              </div>
            </div>
            <div className="col-span-5 flex items-center justify-center md:col-span-2">
              <CircleLink href="/signin" size="lg">
                Sign up with
                <br />
                GitHub
              </CircleLink>
            </div>
            <div className="col-span-1 hidden justify-end md:col-span-2 md:flex">
              <Barcode value="8ec25ff-checkout-api" className="h-32 w-7 text-paper" />
            </div>
          </div>

          <div aria-hidden className="display animate-rise text-right text-[clamp(56px,15.2vw,240px)] [animation-delay:120ms]">
            Developer
          </div>

          <div className="mt-10 flex flex-wrap items-center justify-between gap-4 border-t border-paper/30 pt-5 md:mt-auto">
            <span className="eyebrow">
              <span className="mr-2 inline-block size-2 animate-blink rounded-full bg-paper align-middle" />
              On call for checkout-api
            </span>
            <a href={LINKS.live} target="_blank" rel="noreferrer" className="eyebrow underline-offset-4 hover:underline">
              Live worker on Render ↗
            </a>
            <span className="eyebrow opacity-80">Never merges. Never deploys.</span>
          </div>
        </div>
      </section>

      {/* ────────────────────────────── TICKER ────────────────────────────── */}
      <Marquee
        className="display bg-carbon py-5 text-[clamp(22px,2.6vw,36px)] text-paper [--marquee-duration:55s]"
        items={[
          'Datadog alerts',
          'Read the deployed revision',
          'Investigate',
          'Reproduce — must fail',
          'Patch — must pass',
          'Validate',
          'Open the pull request',
          'A human decides',
        ]}
      />

      {/* ──────────────────────────── GUARANTEES ──────────────────────────── */}
      <section id="guarantees" data-snap className="mx-auto max-w-[1440px] px-5 py-20 md:px-10 md:py-28">
        <div className="mb-10 grid grid-cols-12 gap-5">
          <SectionLabel className="col-span-12 md:col-span-3">Guarantees</SectionLabel>
          <p className="col-span-12 max-w-xl text-[15px] leading-relaxed text-graphite md:col-span-6 md:col-start-7">
            Anyone can wire a model to a stack trace. The hard part is something an on-call engineer would believe at
            3 AM. Each of these is enforced in application code — not requested of a model in a prompt.
          </p>
        </div>

        <div className="border-t border-rule">
          {GUARANTEES.map((g, i) => (
            <Reveal key={g.title} delay={i * 60}>
              <div className="group border-b border-rule py-5 md:py-7">
                <div className="flex items-center gap-6">
                  <h3 className="display flex-1 text-[clamp(36px,6vw,88px)] transition-colors duration-300 group-hover:text-signal">
                    {g.title}
                  </h3>
                  <code className="hidden translate-x-3 rounded bg-carbon px-3 py-2 font-mono text-[11px] text-paper opacity-0 transition-all duration-300 group-hover:translate-x-0 group-hover:opacity-100 lg:block">
                    {g.chip}
                  </code>
                  <span className="shrink-0 text-[12px] text-dim">Guarantee {String(i + 1).padStart(2, '0')}</span>
                </div>
                <div className="grid grid-rows-[1fr] transition-[grid-template-rows] duration-500 ease-out md:grid-rows-[0fr] md:group-hover:grid-rows-[1fr]">
                  <div className="overflow-hidden">
                    <p className="max-w-2xl pt-4 text-[15px] leading-relaxed text-graphite">{g.body}</p>
                  </div>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ───────────────────────────── NUMBERS ────────────────────────────── */}
      <section id="numbers" data-snap className="bg-carbon text-paper">
        <div className="relative overflow-hidden">
          <ShapeGrid />
          <div className="relative mx-auto flex max-w-[1440px] flex-wrap items-end justify-between gap-6 px-5 pt-20 pb-10 md:px-10 md:pt-28">
            <div>
              <SectionLabel className="mb-4">One real incident · checkout-api</SectionLabel>
              <h2 className="display text-[clamp(64px,12vw,190px)]">Numbers</h2>
            </div>
            <CircleLink href={LINKS.demo}>
              Watch
              <br />
              the demo
            </CircleLink>
          </div>
        </div>

        <div className="mx-auto max-w-[1440px] px-5 md:px-10">
          <div className="grid grid-cols-2 border-t border-graphite lg:grid-cols-4">
            {[
              { label: 'Error rate, deploy → merge', node: <CountUp value={64.3} decimals={1} suffix="%" />, red: true },
              { label: 'Error rate, after merge', node: <CountUp value={0} suffix="%" /> },
              { label: 'Requests after the fix', node: <CountUp value={1512} /> },
              { label: 'Tests in pnpm verify', node: <CountUp value={339} /> },
            ].map((s, i) => (
              <div
                key={s.label}
                className={`border-graphite py-8 pr-4 ${i % 2 === 1 ? 'border-l pl-5' : ''} ${i >= 2 ? 'border-t lg:border-t-0' : ''} ${i === 2 ? 'lg:border-l lg:pl-5' : ''}`}
              >
                <div className="eyebrow text-muted">{s.label}</div>
                <div className={`display mt-4 text-[clamp(48px,6vw,92px)] ${s.red ? 'text-signal' : ''}`}>{s.node}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-12 border-t border-graphite">
            <div className="col-span-12 py-8 md:col-span-5 md:pr-8">
              <div className="eyebrow text-muted">Pull requests opened autonomously</div>
              <ul className="mt-5 divide-y divide-graphite border-y border-graphite">
                {LINKS.prs.map((pr) => (
                  <li key={pr.n}>
                    <a
                      href={pr.url}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-center justify-between py-3 transition-colors hover:text-signal"
                    >
                      <span className="display text-[34px]">#{pr.n}</span>
                      <span className="text-[12px] text-muted group-hover:text-signal">merged by a human ↗</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div className="col-span-12 border-graphite py-8 md:col-span-7 md:border-l md:pl-8">
              <div className="eyebrow text-muted">Measured in Datadog, either side of the human merge</div>
              <table className="mt-5 w-full text-left">
                <thead>
                  <tr className="eyebrow border-b border-graphite text-dim">
                    <th className="py-2 font-medium">Window</th>
                    <th className="py-2 text-right font-medium">/orders</th>
                    <th className="py-2 text-right font-medium">HTTP 500</th>
                    <th className="py-2 text-right font-medium">Error rate</th>
                  </tr>
                </thead>
                <tbody className="text-[15px]">
                  <tr className="border-b border-graphite">
                    <td className="py-3">Deploy → merge</td>
                    <td className="py-3 text-right">684</td>
                    <td className="py-3 text-right">440</td>
                    <td className="py-3 text-right font-semibold text-signal">64.3%</td>
                  </tr>
                  <tr className="border-b border-graphite">
                    <td className="py-3">After merge</td>
                    <td className="py-3 text-right">1,512</td>
                    <td className="py-3 text-right">0</td>
                    <td className="py-3 text-right font-semibold">0%</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-4 max-w-lg text-[12px] leading-relaxed text-muted">
                Traffic after the fix was more than double the incident window, so zero errors is not zero traffic.{' '}
                <a href={LINKS.postmortem} target="_blank" rel="noreferrer" className="text-paper underline underline-offset-4">
                  Read the postmortem it filed ↗
                </a>
              </p>
            </div>
          </div>
        </div>
        <div className="h-16 md:h-24" />
      </section>

      {/* ─────────────────────────────── LOOP ─────────────────────────────── */}
      <section id="loop" data-snap className="mx-auto max-w-[1440px] px-5 py-20 md:px-10 md:py-28">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
          <div>
            <SectionLabel className="mb-4">Alert to postmortem</SectionLabel>
            <h2 className="display text-[clamp(64px,12vw,190px)]">The loop</h2>
          </div>
          <CircleLink href="/signin" tone="ink">
            Sign up with
            <br />
            GitHub
          </CircleLink>
        </div>

        <Reveal>
          <figure className="overflow-hidden bg-paper-2">
            {/* Labels are placed against the chart area alone, so they track the drawing at any width. */}
            <div className="relative aspect-[360/110] w-full">
              <DitherIncident />
              <span className="eyebrow absolute top-[26%] left-[3.5%] bg-carbon px-2 py-1 text-paper max-md:text-[9px]">64.3% errors</span>
              <span className="eyebrow absolute top-[5%] left-[43.5%] bg-signal px-2 py-1 text-white max-md:text-[9px]">Human merge</span>
              <span className="eyebrow absolute right-[3.5%] bottom-[14%] bg-carbon px-2 py-1 text-paper max-md:text-[9px]">0% errors</span>
            </div>
            <figcaption className="eyebrow border-t border-rule px-4 py-3 text-graphite">
              One real incident, drawn as its two measured window averages — the pipeline below is what happened in
              between.
            </figcaption>
          </figure>
        </Reveal>

        <ol className="mt-px grid grid-cols-2 gap-px bg-rule md:grid-cols-4">
          {STEPS.map(([title, sub], i) => (
            <li key={title} className="group bg-paper p-5 transition-colors hover:bg-white md:min-h-[190px]">
              <div className="flex items-start justify-between">
                <span className="display text-[42px] text-rule transition-colors group-hover:text-signal">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="eyebrow text-[10px] text-dim">Autonomous</span>
              </div>
              <div className="mt-6 text-[15px] font-semibold uppercase leading-tight tracking-tight">{title}</div>
              <div className="mt-1 text-[13px] text-graphite">{sub}</div>
            </li>
          ))}
          <li className="flex flex-col justify-between bg-signal p-5 text-white md:min-h-[190px]">
            <span className="display text-[42px]">▼</span>
            <div>
              <div className="text-[15px] font-semibold uppercase leading-tight">A human decides</div>
              <div className="mt-1 text-[13px] text-white/85">
                The agent never merges and never deploys, at any autonomy level.
              </div>
            </div>
          </li>
          {AFTER_MERGE.map(([title, sub], i) => (
            <li key={title} className="group bg-paper p-5 transition-colors hover:bg-white md:min-h-[190px]">
              <div className="flex items-start justify-between">
                <span className="display text-[42px] text-rule transition-colors group-hover:text-signal">
                  {String(i + 8).padStart(2, '0')}
                </span>
                <span className="eyebrow text-[10px] text-dim">After merge</span>
              </div>
              <div className="mt-6 text-[15px] font-semibold uppercase leading-tight tracking-tight">{title}</div>
              <div className="mt-1 text-[13px] text-graphite">{sub}</div>
            </li>
          ))}
          <li className="flex flex-col justify-between bg-carbon p-5 text-paper md:min-h-[190px]">
            <span className="eyebrow text-muted">Recovery verdicts</span>
            <div className="space-y-1 font-mono text-[12px]">
              <div className="text-ok">RECOVERED</div>
              <div className="text-signal">NOT_RECOVERED</div>
              <div className="text-sev3">UNVERIFIABLE</div>
            </div>
          </li>
        </ol>
      </section>

      {/* ───────────────────────────── REFUSALS ───────────────────────────── */}
      <section data-snap className="bg-signal text-paper">
        <div className="mx-auto grid max-w-[1440px] grid-cols-12 gap-y-10 px-5 py-20 md:px-10 md:py-28">
          <div className="col-span-12 lg:col-span-5">
            <SectionLabel className="mb-4">The most valuable thing it does</SectionLabel>
            <h2 className="display text-[clamp(64px,10vw,150px)]">
              It
              <br />
              refuses
            </h2>
            <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-paper/85">
              False comfort is the failure mode this system exists to prevent. When the evidence is not there, it says
              so — by name.
            </p>
          </div>
          <ul className="col-span-12 self-end border-t border-paper/30 lg:col-span-7 lg:col-start-6">
            {REFUSALS.map(([token, text]) => (
              <li key={token} className="grid grid-cols-12 items-baseline gap-4 border-b border-paper/30 py-5">
                <ScrambleText
                  text={token}
                  className="col-span-12 w-fit bg-carbon px-2 py-1 font-mono text-[12px] font-semibold text-paper sm:col-span-4"
                />
                <p className="col-span-12 text-[14px] leading-relaxed sm:col-span-8">{text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ────────────────────────────── RUN IT ────────────────────────────── */}
      <section id="run" data-snap className="bg-graphite text-paper">
        <div className="mx-auto max-w-[1440px] px-5 pt-20 md:px-10 md:pt-28">
          <div className="flex flex-wrap items-end justify-between gap-6 pb-10">
            <h2 className="display text-[clamp(64px,12vw,190px)]">Run it</h2>
            <CircleLink href={LINKS.repo}>
              Source
              <br />↗
            </CircleLink>
          </div>

          <div className="grid grid-cols-12 border-t border-paper/20">
            <div className="col-span-12 py-8 md:col-span-6 md:pr-8">
              <div className="eyebrow text-paper/60">Offline, against local twins — no credentials, no network</div>
              <div className="mt-5 overflow-hidden rounded-md bg-carbon">
                <div className="flex items-center justify-between border-b border-graphite px-4 py-2">
                  <span className="font-mono text-[11px] text-muted">zsh</span>
                  <CopyButton text={QUICKSTART} className="eyebrow text-muted hover:text-paper" />
                </div>
                <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-7 text-paper">
                  {QUICKSTART.split('\n').map((line) => {
                    const [cmd, comment] = line.split('#');
                    return (
                      <div key={line}>
                        <span className="text-signal">$ </span>
                        {cmd}
                        {comment && <span className="text-dim">#{comment}</span>}
                      </div>
                    );
                  })}
                </pre>
              </div>
            </div>
            <div className="col-span-6 border-paper/20 py-8 md:col-span-3 md:border-l md:px-8">
              <div className="eyebrow text-paper/60">Adapters</div>
              <ul className="mt-5 space-y-2 text-[15px]">
                {ADAPTERS.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
              <p className="mt-4 text-[12px] leading-relaxed text-paper/60">
                Written against the real vendor APIs. The same code talks to a twin or to production.
              </p>
            </div>
            <div className="col-span-6 border-l border-paper/20 py-8 pl-5 md:col-span-3 md:pl-8">
              <div className="eyebrow text-paper/60">Go</div>
              <ul className="mt-5 space-y-2 text-[15px]">
                <li><Link href="/signin" className="hover:text-signal">Sign up with GitHub →</Link></li>
                <li><a href={LINKS.live} target="_blank" rel="noreferrer" className="hover:text-signal">Live worker ↗</a></li>
                <li><a href={LINKS.demo} target="_blank" rel="noreferrer" className="hover:text-signal">Demo video ↗</a></li>
                <li><a href={LINKS.postmortem} target="_blank" rel="noreferrer" className="hover:text-signal">Postmortem ↗</a></li>
                <li><a href={LINKS.repo} target="_blank" rel="noreferrer" className="hover:text-signal">GitHub ↗</a></li>
              </ul>
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-paper/20 py-6 text-[12px] text-paper/60">
            <Wordmark className="text-paper" />
            <span>7 packages · 3 apps · 339 tests</span>
            <a href="#top" className="hover:text-paper">Back to top ↑</a>
          </footer>
        </div>
      </section>
    </div>
  );
}
