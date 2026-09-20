const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, writeFileSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { spawnSync } = require('child_process');

test('workflow input rejects ambiguous or unsafe job definitions before execution', () => {
  const directory = mkdtempSync(join(tmpdir(), 'taskforge-validation-'));
  const file = join(directory, 'workflow.json');
  const cli = join(__dirname, '..', 'bin', 'taskforge.js');
  const invalid = [
    [{ id: 'same', executable: 'node' }, { id: 'same', executable: 'node' }],
    [{ id: 'build', executable: 'node', dependsOn: ['missing'] }],
    [{ id: 'build', executable: 'node', command: 'echo unsafe' }],
    [{ id: 'build', executable: 'node', args: null }],
    [{ id: 'build', executable: 'node', args: ['bad\0arg'] }],
    [{ id: 'build', command: 'echo okay\nrun' }]
  ];
  try {
    for (const jobs of invalid) {
      writeFileSync(file, JSON.stringify({ jobs }));
      const result = spawnSync(process.execPath, [cli, 'run', file], { encoding: 'utf8' });
      assert.equal(result.status, 1, JSON.stringify(jobs));
      assert.match(result.stderr, /TaskForge:/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
