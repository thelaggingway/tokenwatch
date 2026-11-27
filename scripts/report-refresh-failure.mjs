/** Outage alerting for scheduled refreshes, run by actions/github-script in each workflow's alert job. */
const marker = workflow => `<!-- tokenwatch-refresh-failure: ${workflow} -->`;

const runUrl = context => `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;

async function findOpenIssue({ github, context }) {
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...context.repo, state: 'open', per_page: 100,
  });
  return issues.find(issue => !issue.pull_request && issue.body?.includes(marker(context.workflow))) || null;
}

/** The first failed step of the given job in this run, for the alert text. */
export async function failedStep({ github, context, job }) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...context.repo, run_id: context.runId, per_page: 100,
  });
  return jobs.find(j => j.name === job)?.steps?.find(s => s.conclusion === 'failure')?.name || null;
}

/**
 * One open issue per workflow outage: the first failure opens it, later failures
 * comment on it, and the next successful run closes it.
 */
export async function syncRefreshFailureIssue({ github, context, result, step }) {
  const existing = await findOpenIssue({ github, context });
  if (result === 'success') {
    if (!existing) return 'none';
    await github.rest.issues.createComment({
      ...context.repo, issue_number: existing.number,
      body: `**${context.workflow}** succeeded again: [workflow run](${runUrl(context)}). Closing.`,
    });
    await github.rest.issues.update({ ...context.repo, issue_number: existing.number, state: 'closed' });
    return 'closed';
  }
  const body = `${marker(context.workflow)}\n**${context.workflow}** failed at \`${step || 'unknown step'}\`: [workflow run](${runUrl(context)}).\n\n`
    + 'Fetched data that fails validation is never committed, so the site keeps serving the last good data until this is fixed.';
  if (existing) {
    await github.rest.issues.createComment({ ...context.repo, issue_number: existing.number, body });
    return 'commented';
  }
  await github.rest.issues.create({ ...context.repo, title: `${context.workflow}: scheduled data refresh failing`, body });
  return 'opened';
}
