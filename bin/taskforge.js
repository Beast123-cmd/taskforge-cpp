#!/usr/bin/env node
const http = require('http');
const { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('fs');
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
  const exportFile = join(tmpdir(), `taskforge-${process.pid}-${Date.now()}.json`);
  const input = `${workflowInput(path)}graph\nrun\ngraph\ntimeline\nevents\nexport-json ${exportFile}\nquit\n`;
  const result = spawnSync(binary, { input, encoding: 'utf8' });
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
  if (result.status === 0 && existsSync(exportFile)) {
    const data = JSON.parse(readFileSync(exportFile, 'utf8'));
    unlinkSync(exportFile);
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const runDirectory = join(process.cwd(), '.taskforge', 'runs', runId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, 'run.json'), JSON.stringify({ id: runId, createdAt: new Date().toISOString(), workflow: path, jobs: data.jobs }, null, 2));
    writeFileSync(join(runDirectory, 'events.jsonl'), data.events.map(event => JSON.stringify(event)).join('\n') + '\n');
    writeFileSync(join(runDirectory, 'metrics.json'), JSON.stringify(data.metrics, null, 2));
    console.log(`Run artifacts saved to ${runDirectory}`);
  }
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

function parsePs(output) {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const fields = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.+)$/);
    return fields && { pid: fields[1], ppid: fields[2], cpu: Number(fields[3]), memory: Number(fields[4]), elapsed: fields[5], command: fields[6] };
  }).filter(Boolean);
}

function macSample() {
  const ps = spawnSync('ps', ['-Ao', 'pid=,ppid=,pcpu=,pmem=,etime=,comm=', '-r'], { encoding: 'utf8' });
  const top = spawnSync('top', ['-l', '1', '-n', '0'], { encoding: 'utf8' });
  if (ps.status !== 0) throw new Error(ps.stderr || 'Could not read macOS processes.');
  const match = top.stdout.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys/);
  return { processes: parsePs(ps.stdout), systemCpu: match ? Number(match[1]) + Number(match[2]) : 0 };
}

function linuxSample() {
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid=,pcpu=,pmem=,etime=,comm=', '--sort=-pcpu'], { encoding: 'utf8' });
  const top = spawnSync('top', ['-bn1'], { encoding: 'utf8' });
  if (ps.status !== 0) throw new Error(ps.stderr || 'Could not read Linux processes.');
  const match = top.stdout.match(/%Cpu\(s\):\s*([\d.]+)\s*us,\s*([\d.]+)\s*sy/);
  return { processes: parsePs(ps.stdout), systemCpu: match ? Number(match[1]) + Number(match[2]) : 0 };
}

function windowsSample(previousCpu) {
  const shell = process.env.ComSpec ? 'powershell.exe' : 'powershell';
  const script = "$cpu=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; Get-CimInstance Win32_Process | ForEach-Object {$p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){[PSCustomObject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;cpu=$p.CPU;memory=[math]::Round($p.WorkingSet64/1MB,1);command=$_.Name;systemCpu=$cpu}}} | ConvertTo-Json -Compress";
  const result = spawnSync(shell, ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'Could not read Windows processes.');
  const raw = JSON.parse(result.stdout || '[]');
  const rows = Array.isArray(raw) ? raw : [raw];
  const now = Date.now();
  const elapsedSeconds = previousCpu.time ? Math.max(0.1, (now - previousCpu.time) / 1000) : 1;
  const processes = rows.map(row => {
    const prior = previousCpu.values.get(String(row.pid)) || Number(row.cpu || 0);
    const cpu = previousCpu.time ? Math.max(0, (Number(row.cpu || 0) - prior) / elapsedSeconds * 100) : 0;
    previousCpu.values.set(String(row.pid), Number(row.cpu || 0));
    return { pid: String(row.pid), ppid: String(row.ppid), cpu, memory: Number(row.memory || 0), elapsed: '-', command: row.command };
  }).sort((a, b) => b.cpu - a.cpu);
  previousCpu.time = now;
  return { processes, systemCpu: Number(rows[0]?.systemCpu || 0) };
}

// Read the operating system process table. This is observation-only: unlike
// scheduler jobs, existing processes have no TaskForge dependency metadata.
function monitor() {
  const history = new Map();
  const systemHistory = [];
  const windowsCpu = { time: 0, values: new Map() };
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
    const sample = process.platform === 'darwin' ? macSample() : process.platform === 'linux' ? linuxSample() : process.platform === 'win32' ? windowsSample(windowsCpu) : null;
    if (!sample) throw new Error(`Unsupported platform: ${process.platform}`);
    const { processes, systemCpu } = sample;
    const totalCpu = processes.reduce((total, process) => total + process.cpu, 0);
    systemHistory.push(systemCpu);
    if (systemHistory.length > 40) systemHistory.shift();
    console.clear();
    console.log(`╔════════════════════ TASKFORGE · ${process.platform.toUpperCase()} PROCESS OBSERVATORY ════════════════════╗`);
    console.log(`║ Live OS sampling · refresh 2s · Ctrl+C exits · processes ${String(processes.length).padStart(4)} · process CPU sum ${totalCpu.toFixed(1).padStart(5)}% ║`);
    console.log('╚══════════════════════════════════════════════════════════════════════════════════════════╝');
    console.log(`SYSTEM CPU  ${systemCpu.toFixed(1).padStart(5)}%  ${sparkline(systemHistory).padEnd(40)}  (live OS sample)`);
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
