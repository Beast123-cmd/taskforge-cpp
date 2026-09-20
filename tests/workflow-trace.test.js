const assert = require('node:assert/strict');
const test = require('node:test');
const { createTrace, applyEvent, renderTrace } = require('../lib/workflow-trace');

test('live events update job states and worker lanes', () => {
  const trace = createTrace([{ id: 'build' }, { id: 'test', dependsOn: ['build'] }]);
  applyEvent(trace, { jobId: 'build', state: 'RUNNING', workerId: 2, elapsedMs: 10, message: 'started' });
  assert.equal(trace.workers.get(2), 'build');
  assert.match(renderTrace(trace, 80, 26), /W2  build/);
  applyEvent(trace, { jobId: 'build', state: 'COMPLETED', workerId: 2, elapsedMs: 20, message: 'done' });
  assert.equal(trace.workers.size, 0);
  assert.equal(trace.jobs[0].state, 'COMPLETED');
  applyEvent(trace, { jobId: 'test', state: 'BLOCKED', workerId: 0, elapsedMs: 20, message: 'waiting' });
  assert.match(renderTrace(trace, 80, 26), /test\s+BLOCKED/);
  assert.throws(() => applyEvent(trace, { jobId: 'other', state: 'RUNNING' }), /unknown job/);
});
