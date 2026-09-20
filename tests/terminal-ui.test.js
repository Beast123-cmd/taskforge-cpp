const assert = require('node:assert/strict');
const test = require('node:test');
const { render, visibleProcesses, treeRows } = require('../lib/terminal-ui');

const processes = [
  { pid: '1', ppid: '0', identity: '1:a', command: 'init', cpuPercent: 1,
    memoryBytes: 1048576, startedAt: 'a' },
  { pid: '2', ppid: '1', identity: '2:b', command: 'worker process', cpuPercent: 50,
    memoryBytes: 2097152, startedAt: 'b' }
];
const snapshot = { capturedAt: '2026-09-20T00:00:00Z', platform: 'linux', systemCpuPercent: 25, processes };
const state = { filter: '', sort: 'cpu', selected: 0, scroll: 0, view: 'table',
  paused: false, inputMode: false, message: '', systemHistory: [10, 25], history: new Map() };

test('filter, sort, tree and terminal-size rendering', () => {
  assert.deepEqual(visibleProcesses(snapshot, 'worker', 'cpu').map(row => row.pid), ['2']);
  assert.deepEqual(visibleProcesses(snapshot, '', 'memory').map(row => row.pid), ['2', '1']);
  assert.deepEqual(treeRows(processes, processes[1]).map(row => row.process.pid), ['1', '2']);
  const screen = render(snapshot, state, 80, 24);
  assert.match(screen, /SYSTEM CPU 25\.0%/);
  assert.match(screen, /worker process/);
  assert.equal(screen.split('\n').length, 24);
  assert.ok(screen.split('\n').every(line => line.length <= 80));
});
