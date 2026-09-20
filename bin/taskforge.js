#!/usr/bin/env node
const http = require('http');
const { existsSync, mkdirSync, readFileSync, unlinkSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');
const { tmpdir } = require('os');

const root = join(__dirname, '..');
const binary = join(root, 'build', 'taskforge_demo');
const [command, argument] = process.argv.slice(2);

function build() {
  if (existsSync(binary)) return;
  mkdirSync(join(root, 'build'), { recursive: true });
  const result = spawnSync('c++', ['-std=c++17', '-O2', '-pthread', '-Iinclude', 'src/JobScheduler.cpp', 'src/main.cpp', '-o', binary], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not compile TaskForge. Install a C++17 compiler.\n${result.stderr}`);
}

function workflowInput(path) {
  const workflow = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(workflow.jobs)) throw new Error('Workflow JSON requires a jobs array.');
  return workflow.jobs.map(job => {
    if (!job.id || !job.command) throw new Error('Every job needs id and command.');
    const priority = job.priority || 'medium';
    const dependencies = (job.dependsOn || []).join(',') || '-';
    return `add-command ${job.id} ${priority} ${dependencies} ${job.retries || 0} ${job.command}`;
  }).join('\n') + '\n';
}

function terminalRun(path) {
  build();
  const input = `${workflowInput(path)}graph\nrun\ngraph\nevents\nquit\n`;
  const result = spawnSync(binary, { input, encoding: 'utf8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  process.exitCode = result.status || 0;
}

function telemetry(path) {
  build();
  const file = join(tmpdir(), `taskforge-${process.pid}-${Date.now()}.json`);
  const input = `${path ? workflowInput(path) : 'demo\n'}run\nexport-json ${file}\nquit\n`;
  const result = spawnSync(binary, { input, encoding: 'utf8' });
  if (result.status !== 0 || !existsSync(file)) throw new Error(result.stderr || 'TaskForge engine did not produce telemetry.');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  unlinkSync(file);
  return data;
}

function dashboard(path) {
  const html = readFileSync(join(root, 'web', 'index.html'));
  http.createServer((request, response) => {
    if (request.url === '/api/demo') {
      try { const body = JSON.stringify(telemetry(path)); response.writeHead(200, {'Content-Type':'application/json'}); response.end(body); }
      catch (error) { response.writeHead(500, {'Content-Type':'application/json'}); response.end(JSON.stringify({error: error.message})); }
      return;
    }
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    response.end(html);
  }).listen(4173, () => console.log('Optional dashboard: http://localhost:4173'));
}

// Read the operating system process table. This is observation-only: unlike
// scheduler jobs, existing processes have no TaskForge dependency metadata.
function monitor() {
  if (process.platform !== 'darwin') throw new Error('The initial system monitor targets macOS.');
  const render = () => {
    const result = spawnSync('ps', ['-Ao', 'pid=,ppid=,pcpu=,pmem=,etime=,comm=', '-r'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Could not read the process table.');
    const processes = result.stdout.trim().split('\n').filter(Boolean).map(line => {
      const fields = line.trim().split(/\s+/, 6);
      return { pid: fields[0], ppid: fields[1], cpu: Number(fields[2]), memory: Number(fields[3]), elapsed: fields[4], command: fields[5] || '' };
    });
    const totalCpu = processes.reduce((total, process) => total + process.cpu, 0);
    console.clear();
    console.log('TASKFORGE · macOS PROCESS MONITOR   (refresh: 2s, Ctrl+C to exit)');
    console.log(`Visible processes: ${processes.length}   Aggregate CPU: ${totalCpu.toFixed(1)}%`);
    console.log('─'.repeat(100));
    console.log(' PID     PPID    CPU%    MEM%    ELAPSED       COMMAND');
    for (const process of processes.slice(0, 15)) {
      console.log(`${process.pid.padStart(6)}  ${process.ppid.padStart(6)}  ${process.cpu.toFixed(1).padStart(6)}  ${process.memory.toFixed(1).padStart(6)}  ${process.elapsed.padEnd(12)}  ${process.command.slice(0, 56)}`);
    }
    console.log('\nParent links for the busiest processes:');
    for (const process of processes.slice(0, 6)) console.log(`  ${process.ppid}  →  ${process.pid}  ${process.command.slice(0, 70)}`);
    console.log('\nThis is live OS telemetry. TaskForge can observe these processes, but only jobs it launches have dependency/retry decision traces.');
  };
  render();
  setInterval(render, 2000);
}

try {
  if (!command) {
    build();
    process.exitCode = spawnSync(binary, { cwd: root, stdio: 'inherit' }).status || 0;
  } else if (command === 'run' && argument) {
    terminalRun(argument);
  } else if (command === 'monitor') {
    monitor();
  } else if (command === 'dashboard') {
    dashboard(argument);
  } else {
    console.log('Usage: taskforge | taskforge run <workflow.json> | taskforge monitor | taskforge dashboard [workflow.json]');
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`TaskForge: ${error.message}`);
  process.exitCode = 1;
}
