import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { failedStep, syncRefreshFailureIssue } from '../scripts/report-refresh-failure.mjs';

const read = file => readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8');

// Testing the checkout before fetching let one bad data commit fail every later run
// before it could fetch a fix (the 2026-11-19 and 2026-11-26 outages).
for (const [file, job, fetch, commit] of [
  ['refresh-pricing.yml', 'refresh', 'Fetch & normalize text pricing', 'Commit pricing + performance data'],
  ['refresh-performance.yml', 'perf', 'Fetch performance data', 'Commit performance data'],
]) {
  const source = read(file);
  const body = source.split(`\n  ${job}:\n`)[1].split(/^  [\w-]+:\n/m)[0];
  const steps = [...body.matchAll(/^      - name: (.+)$/gm)].map(m => m[1]);

  test(`${file}: refreshed data is validated after fetching and before it is committed`, () => {
    const validate = steps.indexOf('Validate refreshed data');
    assert.ok(validate > steps.indexOf(fetch) && steps.indexOf(fetch) >= 0, 'validation must follow the fetch');
    assert.ok(validate < steps.indexOf(commit), 'validation must precede the commit');
    assert.ok(!steps.slice(0, steps.indexOf(fetch)).some(s => /test|validat/i.test(s)), 'no test gate before the fetch');
    const step = body.split('      - name: Validate refreshed data\n')[1].split(/\n      - /)[0];
    assert.match(step, /run: node --test test\/\*\.test\.mjs/);
    assert.doesNotMatch(step, /continue-on-error|if:/, 'validation must block the commit');
  });

  test(`${file}: an alert job tracks failed and recovered refreshes`, () => {
    const alert = source.split('\n  alert:\n')[1];
    assert.ok(alert, 'missing alert job');
    assert.match(alert, new RegExp(`^    needs: ${job}$`, 'm'));
    assert.match(alert, /^    if: always\(\)/m);
    assert.match(alert, /issues: write/);
    assert.match(alert, new RegExp(`job: '${job}'`));
  });
}

function fakeGithub(openIssues = []) {
  const calls = [];
  const record = name => async args => { calls.push([name, args]); return { data: {} }; };
  return {
    calls,
    paginate: async (method, args) => method(args),
    rest: {
      issues: {
        listForRepo: () => openIssues,
        create: record('create'),
        createComment: record('comment'),
        update: record('update'),
      },
      actions: {
        listJobsForWorkflowRun: () => [
          { name: 'refresh', steps: [{ name: 'Fetch', conclusion: 'success' }, { name: 'Validate refreshed data', conclusion: 'failure' }] },
        ],
      },
    },
  };
}
const context = { workflow: 'Refresh Pricing', serverUrl: 'https://github.com', repo: { owner: 'o', repo: 'r' }, runId: 7 };
const marker = '<!-- tokenwatch-refresh-failure: Refresh Pricing -->';

test('the first failure opens an issue naming the failed step', async () => {
  const github = fakeGithub();
  assert.equal(await failedStep({ github, context, job: 'refresh' }), 'Validate refreshed data');
  assert.equal(await syncRefreshFailureIssue({ github, context, result: 'failure', step: 'Validate refreshed data' }), 'opened');
  const [[name, args]] = github.calls;
  assert.equal(name, 'create');
  assert.ok(args.body.includes(marker) && args.body.includes('Validate refreshed data') && args.body.includes('/actions/runs/7'));
});

test('later failures comment on the open issue; recovery closes it; other workflows are untouched', async () => {
  const open = [{ number: 3, body: `${marker}\nfailed` }, { number: 4, body: 'pr', pull_request: {} }];
  let github = fakeGithub(open);
  assert.equal(await syncRefreshFailureIssue({ github, context, result: 'failure', step: 'x' }), 'commented');
  assert.equal(github.calls[0][1].issue_number, 3);

  github = fakeGithub(open);
  assert.equal(await syncRefreshFailureIssue({ github, context, result: 'success' }), 'closed');
  assert.deepEqual(github.calls.map(([n, a]) => [n, a.issue_number, a.state]), [['comment', 3, undefined], ['update', 3, 'closed']]);

  github = fakeGithub(open);
  assert.equal(await syncRefreshFailureIssue({ github, context: { ...context, workflow: 'Refresh Performance' }, result: 'success' }), 'none');
  assert.equal(github.calls.length, 0);
});
