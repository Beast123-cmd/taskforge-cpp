# TaskForge

TaskForge is a local-first C++17 scheduling and concurrency observability tool. It runs dependency-aware command workflows on reusable worker threads, records why every scheduling decision occurred, and provides a cross-platform terminal process observatory.

```text
Workflow JSON --> TaskForge CLI --> C++ Scheduler --> worker threads --> command processes
                      |                 |
                      |                 +--> dependency DAG / priority queue / event audit trail
                      +--> live OS process topology and CPU telemetry
```

## What it does

- Priority scheduling with deterministic FIFO ordering for equal priorities
- Dependency DAGs, cycle detection, blocked-job propagation, retries, and failure cancellation
- Reusable `std::thread` worker pool with condition-variable wakeups and graceful shutdown
- Structured scheduler event audit trail: submitted, blocked, ready, running, retrying, failed, completed
- Terminal graph, status table, execution metrics, and decision timeline for every TaskForge workflow
- Read-only live process observatory: sampled system CPU, process CPU history, memory use, and parent → child topology
- macOS, Linux, and Windows process collectors; C++ build/test CI targets all three platforms

## Install

```sh
npm install -g github:Beast123-cmd/taskforge-cpp
taskforge
```

This opens the interactive terminal console. Monitoring and saved-run commands only need Node.js 18+. Running workflows compiles the C++ engine on first use: macOS/Linux need a C++17 compiler (`c++`), and Windows needs CMake plus a C++17 toolchain such as Visual Studio Build Tools. The npm package contains source, not prebuilt binaries. Update an existing installation with `npm install -g github:Beast123-cmd/taskforge-cpp --force`.

## Run a real workflow

```sh
taskforge run examples/cpu-workflow.json
```

Each command is a real child process executed by a C++ worker thread. The terminal automatically prints the graph before and after execution, job table, metrics, and decision trace.

To watch those scheduler decisions while the workflow is still running:

```sh
taskforge trace examples/cpu-workflow.json
```

In an interactive terminal, this opens a live view of job states, prerequisite relationships, active worker lanes, recent scheduler decisions, and command output. In a pipe or CI job it emits timestamped event lines. The events come directly from the C++ scheduler, and the completed trace is saved with the same run artifacts as `taskforge run`.

Every `taskforge run` also creates a durable local record:

```text
.taskforge/runs/run-<timestamp>/
├── run.json        workflow identity and final job states
├── events.jsonl    append-friendly scheduler event history
└── metrics.json    final aggregate metrics
```

Events include the responsible worker ID when applicable, allowing the terminal timeline to show which worker ran each task and for how long.

## Inspect and replay saved runs

From the directory where you ran the workflow:

```sh
taskforge runs
taskforge show run-<timestamp>
taskforge replay run-<timestamp>
taskforge replay run-<timestamp> --speed 4
```

`runs` lists previous executions. `show` displays final job states, dependencies, metrics, and a worker-occupancy chart that makes overlap visible. `replay` reconstructs job states and worker activity from `events.jsonl` at the recorded timing. In a terminal, Space pauses, ←/→ steps through events, +/- changes speed, ↑/↓ scrolls jobs, and `q` exits. Piped output prints timestamped events. Replay only reads saved artifacts; it never executes workflow commands.

```json
{
  "jobs": [
    { "id": "build", "priority": "high", "executable": "node", "args": ["scripts/build.js"] },
    { "id": "test", "priority": "medium", "dependsOn": ["build"], "retries": 1, "executable": "node", "args": ["--test"] }
  ]
}
```

Each job needs an `id` and exactly one of `executable` or `command`. Prefer `executable` with a string `args` array: arguments are passed literally to the process on macOS, Linux, and Windows, without shell expansion. Executables may be absolute paths or found on `PATH`; use a native executable (for example `node`, not a Windows `.cmd` wrapper). `command` remains available for workflows that intentionally need shell syntax, such as `npm run build`, and should only be used with trusted workflow files. `priority` defaults to `medium`, `dependsOn` to an empty list, and `retries` to `0`.

## Observe the host machine

```sh
taskforge monitor
```

The full-screen terminal observatory refreshes every two seconds. It shows sampled system CPU, per-process CPU sparklines, busiest processes, resident memory, and a real process topology graph. It reads your machine's current OS processes; it does not use demo tasks.

Use ↑/↓ to select a process, `c`/`m`/`i` to sort by CPU/memory/PID, `t` to switch between table and parent/child views, `/` to filter by command or PID, Space to pause, and `q` to quit. The selected process's details stay visible at the bottom. The view adapts to terminal resizing and restores your terminal on exit.

For a one-shot, machine-readable sample of the 25 busiest processes:

```sh
taskforge snapshot
```

The command takes two readings one second apart. Process CPU is the CPU time consumed during that interval as a percentage of one logical core (so a multi-threaded process may exceed 100%). A newly seen process has no prior reading and reports 0% until the next interval. Memory is resident memory in bytes in JSON and MiB in the monitor table. Each process has a `pid:start-time` identity so a recycled PID does not inherit the old process's CPU history. `systemCpuPercent` may be `null` until a system-level interval is available.

Each monitor session is persisted while it runs:

```sh
taskforge monitor
taskforge sessions
taskforge inspect monitor-<timestamp>
```

Snapshots are stored in `.taskforge/monitor/<session-id>/snapshots.jsonl`, so a completed live observation can be inspected without re-running the monitor.

```text
[1 launchd]
├─ [Google Chrome]
│  ├─ [Chrome Renderer]
│  └─ [Chrome Helper]
└─ [Code]
   └─ [Code Helper]
```

This graph is OS ancestry (`parent PID → child PID`), not a fabricated workflow DAG. Existing system processes have no TaskForge priority, retry, or dependency metadata.

| Platform | Process collector | CPU source |
| --- | --- | --- |
| macOS | `ps` cumulative CPU time and RSS | `top` |
| Linux | `ps` cumulative CPU time and RSS | `/proc/stat` interval |
| Windows | PowerShell/CIM cumulative CPU time and working set | `Win32_Processor` |

## Interactive console

```text
taskforge> help
taskforge> demo
taskforge> graph
taskforge> list
taskforge> run
taskforge> events
```

Useful commands: `add`, `add-command`, `list`, `status <id>`, `graph`, `events`, `summary`, `export <file.dot>`, `export-json <file.json>`, and `quit`.

The optional browser view is available with `taskforge dashboard [workflow.json]`; the terminal is the primary interface.

## Build and test

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
npm test
```

The test executable covers priority/FIFO behavior, dependency resolution and blocking, cycle detection, retries, permanent failures, failure propagation, metrics, concurrent workers, and graceful shutdown. GitHub Actions builds and tests on macOS, Ubuntu, and Windows.

## Design and scope

Ready-job selection is `O(log n)` with the priority queue. Dependency propagation follows only direct dependents; DFS cycle detection is `O(V + E)`. One scheduler mutex protects state transitions, but arbitrary command work runs outside that lock.

TaskForge is intentionally local-first: no cloud account, Redis, database, Docker, or remote machine control. GitHub/npm tarball installation is supported; publishing a named package to the npm registry is a separate maintainer release action and has not been done yet.
