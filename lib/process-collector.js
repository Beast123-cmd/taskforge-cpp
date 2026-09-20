const { readFileSync } = require('fs');
const { spawnSync } = require('child_process');

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`Process collection failed (${command}): ${result.error?.message || result.stderr || result.status}`);
  }
  return result.stdout;
}

function cpuSeconds(value) {
  const [clock, fraction = '0'] = value.split('.');
  const [dayText, timeText] = clock.includes('-') ? clock.split('-') : [null, clock];
  const parts = timeText.split(':').map(Number);
  if (parts.some(Number.isNaN)) return NaN;
  const seconds = parts.pop();
  const minutes = parts.pop() || 0;
  const hours = parts.pop() || 0;
  return Number(dayText || 0) * 86400 + hours * 3600 + minutes * 60 + seconds + Number(`0.${fraction}`);
}

// ps time is [[dd-]hh:]mm:ss. Keep the original start text as a stable
// process identity component; PIDs alone are recycled by every OS.
function parsePs(output) {
  return output.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.-]+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/);
    if (!match) return [];
    const [, pid, ppid, time, rss, startedAt, command] = match;
    const totalCpuSeconds = cpuSeconds(time);
    if (!Number.isFinite(totalCpuSeconds)) return [];
    return [{ pid, ppid, identity: `${pid}:${startedAt}`, startedAt, command,
      totalCpuSeconds, memoryBytes: Number(rss) * 1024 }];
  });
}

function parseWindows(output) {
  const raw = JSON.parse(output.trim() || '[]');
  return (Array.isArray(raw) ? raw : [raw]).filter(row => row && row.pid != null).map(row => ({
    pid: String(row.pid), ppid: String(row.ppid),
    identity: `${row.pid}:${row.startedAt}`, startedAt: row.startedAt,
    command: row.command, totalCpuSeconds: Number(row.totalCpuSeconds || 0),
    memoryBytes: Number(row.memoryBytes || 0)
  }));
}

function linuxCpu(output) {
  const values = output.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const total = values.reduce((sum, value) => sum + value, 0);
  const idle = values[3] + values[4];
  return { total, idle };
}

function normalize(rows, capturedAt, previous) {
  const elapsed = previous ? (capturedAt - previous.capturedAt) / 1000 : 0;
  const prior = previous?.totals || new Map();
  const totals = new Map();
  const processes = rows.map(row => {
    totals.set(row.identity, row.totalCpuSeconds);
    const before = prior.get(row.identity);
    const cpuPercent = elapsed > 0 && before !== undefined
      ? Math.max(0, (row.totalCpuSeconds - before) / elapsed * 100) : 0;
    return { ...row, cpuPercent: Number(cpuPercent.toFixed(1)) };
  }).sort((a, b) => b.cpuPercent - a.cpuPercent || Number(a.pid) - Number(b.pid));
  return { processes, state: { capturedAt, totals } };
}

function collect(previous = null, platform = process.platform) {
  const capturedAt = Date.now();
  let rows;
  let systemCpuPercent = null;
  let systemTimes = null;

  if (platform === 'darwin' || platform === 'linux') {
    rows = parsePs(run('ps', [platform === 'darwin' ? '-Ao' : '-eo',
      'pid=,ppid=,time=,rss=,lstart=,comm=']));
    if (platform === 'darwin') {
      const match = run('top', ['-l', '1', '-n', '0']).match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys/);
      if (match) systemCpuPercent = Number(match[1]) + Number(match[2]);
    } else {
      systemTimes = linuxCpu(readFileSync('/proc/stat', 'utf8'));
      if (previous?.systemTimes) {
        const total = systemTimes.total - previous.systemTimes.total;
        const idle = systemTimes.idle - previous.systemTimes.idle;
        if (total > 0) systemCpuPercent = Math.max(0, Math.min(100, (total - idle) / total * 100));
      }
    }
  } else if (platform === 'win32') {
    const script = '$ErrorActionPreference="Stop"; Get-CimInstance Win32_Process | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){ [PSCustomObject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; startedAt=[string]$_.CreationDate; command=$_.Name; totalCpuSeconds=$p.CPU; memoryBytes=$p.WorkingSet64 } } } | ConvertTo-Json -Compress';
    rows = parseWindows(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
    const load = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average']);
    const value = Number(load.trim());
    if (Number.isFinite(value)) systemCpuPercent = value;
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const normalized = normalize(rows, capturedAt, previous);
  return { snapshot: { capturedAt: new Date(capturedAt).toISOString(), platform,
    systemCpuPercent, processes: normalized.processes },
    state: { ...normalized.state, systemTimes } };
}

module.exports = { collect, normalize, parsePs, parseWindows, linuxCpu, cpuSeconds };
