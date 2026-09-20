const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { spawnSync } = require('child_process');
const { loadRun, listRuns, workerTimeline, timelineChart } = require('../lib/run-history');

test('saved runs are listed, loaded, and guarded against path traversal', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'taskforge-history-'));
  const directory = join(workspace, '.taskforge', 'runs');
  const id = 'run-2026-09-20T12-00-00-000Z';
  try {
    mkdirSync(join(directory, id), { recursive: true });
    writeFileSync(join(directory, id, 'run.json'), JSON.stringify({ id, createdAt: '2026-09-20', workflow: 'workflow.json', jobs: [{ id: 'a', state: 'COMPLETED' }] }));
    writeFileSync(join(directory, id, 'metrics.json'), JSON.stringify({ completed: 1, failed: 0 }));
    writeFileSync(join(directory, id, 'events.jsonl'), '{"jobId":"a","state":"COMPLETED","elapsedMs":10,"workerId":1}\n');
    assert.equal(listRuns(directory)[0].completed, 1);
    assert.equal(loadRun(directory, id).events.length, 1);
    assert.throws(() => loadRun(directory, '../outside'), /Invalid run ID/);
    const cli = join(__dirname, '..', 'bin', 'taskforge.js');
    for (const command of [['runs'], ['show', id], ['replay', id]]) {
      const result = spawnSync(process.execPath, [cli, ...command], { cwd: workspace, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /run-2026-09-20T12-00-00-000Z/);
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('worker timeline preserves overlapping execution and retry attempts', () => {
  const events = [
    { jobId: 'a', state: 'RUNNING', workerId: 1, elapsedMs: 0 },
    { jobId: 'b', state: 'RUNNING', workerId: 2, elapsedMs: 5 },
    { jobId: 'a', state: 'READY', workerId: 1, elapsedMs: 10 },
    { jobId: 'b', state: 'COMPLETED', workerId: 2, elapsedMs: 20 },
    { jobId: 'a', state: 'RUNNING', workerId: 1, elapsedMs: 25 },
    { jobId: 'a', state: 'COMPLETED', workerId: 1, elapsedMs: 30 }
  ];
  const spans = workerTimeline(events);
  assert.deepEqual(spans.map(span => span.durationMs), [10, 15, 5]);
  assert.match(timelineChart(spans, 10).join('\n'), /CONC .*2/);
});
