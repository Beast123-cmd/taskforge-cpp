const { clip } = require('./terminal-ui');

function createTrace(jobs) {
  return { jobs: jobs.map(job => ({ ...job, state: 'PENDING', workerId: 0 })),
    events: [], logs: [], workers: new Map(), scroll: 0 };
}

function applyEvent(trace, event) {
  const job = trace.jobs.find(item => item.id === event.jobId);
  if (!job) throw new Error(`Scheduler reported unknown job: ${event.jobId}`);
  job.state = event.state;
  job.workerId = event.state === 'RUNNING' || ['COMPLETED', 'FAILED'].includes(event.state)
    ? event.workerId : 0;
  if (event.state === 'RUNNING') {
    trace.workers.set(event.workerId, event.jobId);
  } else if (event.workerId) {
    trace.workers.delete(event.workerId);
  }
  trace.events.push(event);
  if (trace.events.length > 100) trace.events.shift();
}

function renderTrace(trace, width = 100, height = 30) {
  width = Math.max(48, width);
  height = Math.max(16, height);
  const count = state => trace.jobs.filter(job => job.state === state).length;
  const playback = trace.playback;
  const lines = [
    clip(playback ? `TASKFORGE  •  RECORDED WORKFLOW REPLAY  •  ${playback.cursorMs}/${playback.totalMs} ms  ${playback.speed}× ${playback.paused ? 'PAUSED' : 'PLAYING'}` : 'TASKFORGE  •  LIVE WORKFLOW TRACE', width),
    '─'.repeat(width),
    clip(`RUNNING ${count('RUNNING')}  READY ${count('READY')}  BLOCKED ${count('BLOCKED')}  COMPLETED ${count('COMPLETED')}  FAILED ${count('FAILED')}  CANCELLED ${count('CANCELLED')}`, width),
    '─'.repeat(width),
    clip(`JOB                  STATE        WORKER  DEPENDENCIES  (${Math.min(trace.scroll + 1, trace.jobs.length)}-${Math.min(trace.scroll + Math.max(1, height - 15), trace.jobs.length)}/${trace.jobs.length})`, width)
  ];
  for (const job of trace.jobs.slice(trace.scroll, trace.scroll + Math.max(1, height - 15))) {
    const dependencies = (job.dependsOn || []).join(', ') || 'entry';
    lines.push(clip(`${job.id.padEnd(20)} ${job.state.padEnd(12)} ${(job.workerId ? `W${job.workerId}` : '—').padEnd(7)} ${dependencies}`, width));
  }
  lines.push('─'.repeat(width), clip('WORKER LANES', width));
  const workerCount = Math.max(3, ...trace.workers.keys());
  for (let worker = 1; worker <= Math.min(workerCount, 8); worker++) {
    lines.push(clip(`W${worker}  ${trace.workers.get(worker) || 'idle'}`, width));
  }
  lines.push('─'.repeat(width), clip('LATEST SCHEDULER DECISIONS', width));
  const room = Math.max(1, height - lines.length - 5);
  for (const event of trace.events.slice(-room)) {
    lines.push(clip(`${String(event.elapsedMs).padStart(6)} ms  ${(event.workerId ? `W${event.workerId}` : 'scheduler').padEnd(9)} ${event.jobId.padEnd(18)} ${event.state.padEnd(10)} ${event.message}`, width));
  }
  lines.push('─'.repeat(width), clip('COMMAND OUTPUT', width));
  for (const log of trace.logs.slice(-2)) lines.push(clip(log, width));
  while (lines.length < height - 1) lines.push('');
  lines.push(clip(playback ? 'Space pause/play  ←→ step  +/- speed  ↑↓ scroll  q quit' : '↑↓ scroll jobs • q / Ctrl+C stops the workflow', width));
  return lines.slice(0, height).join('\n');
}

module.exports = { createTrace, applyEvent, renderTrace };
