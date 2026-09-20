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
  const history = new Map();
  const systemHistory = [];
  const processLabel = process => `${process.pid} ${process.command.split('/').pop().slice(0, 32)} (${process.cpu.toFixed(1)}%)`;
  const sparkline = values => {
    const blocks = '▁▂▃▄▅▆▇█';
    return values.map(value => blocks[Math.min(7, Math.max(0, Math.round(value / 100 * 7)))]).join('');
  };
  const drawTree = (pid, byPid, children, indent = '', branch = '') => {
    const process = byPid.get(pid);
    if (!process) return;
    console.log(`${indent}${branch}[${processLabel(process)}]`);
    const descendants = (children.get(pid) || []).sort((a, b) => byPid.get(b).cpu - byPid.get(a).cpu);
    descendants.forEach((child, index) => {
      const last = index === descendants.length - 1;
      drawTree(child, byPid, children, indent + (branch ? (branch === '└─ ' ? '   ' : '│  ') : ''), last ? '└─ ' : '├─ ');
    });
  };
  const render = () => {
    const result = spawnSync('ps', ['-Ao', 'pid=,ppid=,pcpu=,pmem=,etime=,comm=', '-r'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'Could not read the process table.');
    const processes = result.stdout.trim().split('\n').filter(Boolean).map(line => {
      const fields = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
      if (!fields) return null;
      return { pid: fields[1], ppid: fields[2], cpu: Number(fields[3]), memory: Number(fields[4]), elapsed: fields[5], command: fields[6] };
    }).filter(Boolean);
    const totalCpu = processes.reduce((total, process) => total + process.cpu, 0);
    const top = spawnSync('top', ['-l', '1', '-n', '0'], { encoding: 'utf8' });
    const cpuLine = (top.stdout.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys/) || []);
    const systemCpu = cpuLine.length ? Number(cpuLine[1]) + Number(cpuLine[2]) : 0;
    systemHistory.push(systemCpu);
    if (systemHistory.length > 40) systemHistory.shift();
    console.clear();
    console.log('╔════════════════════════ TASKFORGE · macOS PROCESS OBSERVATORY ════════════════════════╗');
    console.log(`║ Live OS sampling · refresh 2s · Ctrl+C exits · processes ${String(processes.length).padStart(4)} · process CPU sum ${totalCpu.toFixed(1).padStart(5)}% ║`);
    console.log('╚══════════════════════════════════════════════════════════════════════════════════════════╝');
    console.log(`SYSTEM CPU  ${systemCpu.toFixed(1).padStart(5)}%  ${sparkline(systemHistory).padEnd(40)}  (sampled from macOS top)`);
    console.log('─'.repeat(110));
    console.log(' PID     PPID    CPU%    MEM%    ELAPSED       CPU HISTORY   COMMAND');
    for (const process of processes.slice(0, 15)) {
      const samples = [...(history.get(process.pid) || []), process.cpu].slice(-12);
      history.set(process.pid, samples);
      console.log(`${process.pid.padStart(6)}  ${process.ppid.padStart(6)}  ${process.cpu.toFixed(1).padStart(6)}  ${process.memory.toFixed(1).padStart(6)}  ${process.elapsed.padEnd(12)}  ${sparkline(samples).padEnd(12)}  ${process.command.slice(0, 48)}`);
    }
    // Keep busy processes plus their ancestors; this is a real PPID topology.
    const byPid = new Map(processes.map(process => [process.pid, process]));
    const included = new Set();
    for (const process of processes.slice(0, 10)) {
      for (let current = process; current && !included.has(current.pid); current = byPid.get(current.ppid)) included.add(current.pid);
    }
    const children = new Map();
    for (const pid of included) {
      const process = byPid.get(pid);
      if (included.has(process.ppid)) children.set(process.ppid, [...(children.get(process.ppid) || []), pid]);
    }
    const roots = [...included].filter(pid => !included.has(byPid.get(pid).ppid));
    console.log('\nLIVE PROCESS TOPOLOGY  (parent → child relationships from macOS PPID data)');
    roots.sort((a, b) => byPid.get(b).cpu - byPid.get(a).cpu).forEach(root => drawTree(root, byPid, children));
    console.log('\nThis graph is real OS process ancestry. Logical task dependencies, priorities, and retries exist only for workflows TaskForge launches.');
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
