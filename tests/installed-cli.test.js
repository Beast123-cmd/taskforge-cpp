const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, writeFileSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { spawnSync } = require('child_process');

test('packed CLI runs executable jobs in the caller working directory', () => {
  const npmRoot = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(npmRoot.status, 0, npmRoot.stderr);
  const cli = join(npmRoot.stdout.trim(), 'taskforge-scheduler', 'bin', 'taskforge.js');
  const workspace = mkdtempSync(join(tmpdir(), 'taskforge-installed-'));
  try {
    writeFileSync(join(workspace, 'workflow.json'), JSON.stringify({ jobs: [{
      id: 'check_cwd', executable: 'node',
      args: ['-e', "const fs=require('fs'); if (fs.realpathSync(process.cwd()) !== fs.realpathSync(process.argv[1])) process.exit(5); console.log('cwd preserved')", workspace]
    }] }));
    const result = spawnSync(process.execPath, [cli, 'trace', 'workflow.json'], {
      cwd: workspace, encoding: 'utf8', timeout: 120000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /cwd preserved/);
    assert.match(result.stdout, /Workflow completed: 1\/1/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
