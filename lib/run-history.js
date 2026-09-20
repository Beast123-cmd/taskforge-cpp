const { existsSync, readFileSync, readdirSync } = require('fs');
const { join } = require('path');

function loadRun(directory, id) {
  if (!/^run-[A-Za-z0-9._-]+$/.test(id || '')) throw new Error('Invalid run ID.');
  const path = join(directory, id);
  const run = JSON.parse(readFileSync(join(path, 'run.json'), 'utf8'));
  const metrics = JSON.parse(readFileSync(join(path, 'metrics.json'), 'utf8'));
  const events = readFileSync(join(path, 'events.jsonl'), 'utf8').split('\n')
    .filter(Boolean).map(line => JSON.parse(line));
  if (run.id !== id || !Array.isArray(run.jobs) || !Array.isArray(events)) {
    throw new Error(`Invalid run artifacts: ${id}`);
  }
  return { run, metrics, events };
}

function listRuns(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^run-[A-Za-z0-9._-]+$/.test(entry.name))
    .map(entry => {
      try {
        const path = join(directory, entry.name);
        const run = JSON.parse(readFileSync(join(path, 'run.json'), 'utf8'));
        const metrics = JSON.parse(readFileSync(join(path, 'metrics.json'), 'utf8'));
        if (run.id !== entry.name || !Array.isArray(run.jobs)) throw new Error('invalid run.json');
        return { id: entry.name, createdAt: run.createdAt, workflow: run.workflow,
          completed: metrics.completed, total: run.jobs.length,
          failed: run.jobs.filter(job => job.state !== 'COMPLETED').length };
      } catch (error) {
        return { id: entry.name, error: error.message };
      }
    }).sort((a, b) => b.id.localeCompare(a.id));
}

// Derive worker occupancy from the durable event stream, including retries.
function workerTimeline(events) {
  const active = new Map();
  const spans = [];
  for (const event of events) {
    if (!event.workerId) continue;
    if (event.state === 'RUNNING') {
      active.set(event.workerId, event);
    } else if (active.has(event.workerId)) {
      const started = active.get(event.workerId);
      spans.push({ workerId: event.workerId, jobId: started.jobId,
        startMs: started.elapsedMs, endMs: event.elapsedMs,
        durationMs: event.elapsedMs - started.elapsedMs, outcome: event.state });
      active.delete(event.workerId);
    }
  }
  return spans;
}

function timelineChart(spans, width = 40) {
  if (!spans.length) return [];
  const end = Math.max(1, ...spans.map(span => span.endMs));
  const workers = [...new Set(spans.map(span => span.workerId))].sort((a, b) => a - b);
  const lanes = workers.map(workerId => {
    const cells = Array(width).fill('·');
    for (const span of spans.filter(item => item.workerId === workerId)) {
      const start = Math.min(width - 1, Math.floor(span.startMs / end * width));
      const stop = Math.max(start + 1, Math.ceil(span.endMs / end * width));
      for (let index = start; index < Math.min(width, stop); index++) cells[index] = '█';
    }
    return { workerId, cells };
  });
  return [`     0 ms${' '.repeat(Math.max(1, width - 12))}${end} ms`,
    ...lanes.map(lane => `W${String(lane.workerId).padEnd(3)} ${lane.cells.join('')}`),
    `CONC ${Array.from({ length: width }, (_, index) => String(Math.min(9, lanes.filter(lane => lane.cells[index] === '█').length))).join('')}`];
}

module.exports = { loadRun, listRuns, workerTimeline, timelineChart };
