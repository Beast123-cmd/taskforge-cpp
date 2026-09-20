const assert = require('node:assert/strict');
const test = require('node:test');
const { cpuSeconds, parsePs, parseWindows, normalize, linuxCpu, collect } = require('../lib/process-collector');

test('parses cumulative CPU time and process names containing spaces', () => {
  assert.equal(cpuSeconds('01:02'), 62);
  assert.equal(cpuSeconds('02:01:02.50'), 7262.5);
  assert.equal(cpuSeconds('1-02:01:02'), 93662);
  const rows = parsePs('  42  1  02:01.25  1024  Sun Sep 20 12:34:56 2026  /Applications/My App\n');
  assert.equal(rows[0].memoryBytes, 1048576);
  assert.equal(rows[0].command, '/Applications/My App');
  assert.equal(rows[0].totalCpuSeconds, 121.25);
});

test('CPU deltas use process identity and do not carry history across PID reuse', () => {
  const row = (identity, totalCpuSeconds) => ({ pid: '42', ppid: '1', identity, totalCpuSeconds, memoryBytes: 1, command: 'job' });
  const first = normalize([row('42:start-a', 5)], 1000);
  const second = normalize([row('42:start-a', 6), row('42:start-b', 8)], 2000, first.state);
  assert.equal(second.processes[0].cpuPercent, 100);
  assert.equal(second.processes[1].cpuPercent, 0);
});

test('Windows JSON and Linux CPU counters share the snapshot contract', () => {
  assert.equal(parseWindows('{"pid":7,"ppid":1,"startedAt":"date","command":"test","totalCpuSeconds":2,"memoryBytes":4096}')[0].identity, '7:date');
  assert.deepEqual(linuxCpu('cpu  10 0 20 30 5 0 0 0 0 0\n'), { total: 65, idle: 35 });
});

test('host collector returns real OS processes', () => {
  const first = collect();
  assert.equal(first.snapshot.platform, process.platform);
  assert.ok(first.snapshot.processes.length > 0);
  assert.ok(first.snapshot.processes.some(process => process.pid === String(process.pid) && process.identity));
  assert.ok(first.snapshot.processes.every(process => Number.isFinite(process.memoryBytes)));
});
