# TaskForge

TaskForge is a focused C++17 multithreaded job scheduler: it runs reusable worker threads, honors dependencies, selects ready jobs by priority (FIFO on ties), retries controlled failures, and exposes execution metrics.

## Architecture

```text
Job submissions --> JobScheduler --> SchedulingStrategy --> worker threads
       |                 |                 |                    |
       +--> dependency adjacency list <----+---- status/metrics <-+
```

`JobScheduler` owns synchronized job state and the dependency adjacency list. A `SchedulingStrategy` owns only ready-job ordering; the supplied priority strategy uses a priority queue and FIFO sequence counter, while `FIFOSchedulingStrategy` ignores priority. Workers sleep on a condition variable and execute functions outside the scheduler lock.

## Features

- PENDING, BLOCKED, READY, RUNNING, COMPLETED, FAILED, and CANCELLED states
- High/medium/low priority scheduling with deterministic FIFO tie breaking
- Dependency propagation and DFS cycle rejection; forward dependency references are checked at `start()`
- Reproducible retry handling and cancellation of work whose dependency permanently failed
- Thread-safe metrics: submitted/completed/failed/retries, wait/run time, current and peak concurrency
- Validation for duplicate IDs, missing dependencies, invalid jobs, duplicate starts, and shutdown

## Build and run

```sh
cmake -S . -B build
cmake --build build
./build/taskforge_demo
ctest --test-dir build --output-on-failure
```

## Dashboard installation (npm)

TaskForge can also be installed as a local developer tool directly from this repository:

```sh
npm install -g github:Beast123-cmd/taskforge-cpp
taskforge
```

Then open `http://localhost:4173`. The dashboard starts the real C++ engine on demand and renders its exported telemetry: dependency flow, job states, scheduler decisions, retry behavior, and measured peak concurrency. It requires Node.js 18+ and a C++17 compiler on the local machine. A registry publication can later replace the GitHub installation URL with `npm install -g taskforge-scheduler`.

## Interactive CLI

`taskforge_demo` opens an interactive prompt; it does not automatically run a fixed workload. Use `help` at the prompt for the full command reference.

```text
taskforge> add ingest high 100 - 0 0
taskforge> add report low 75 ingest 0 0
taskforge> graph
taskforge> list
taskforge> run
taskforge> status report
taskforge> summary
```

The `add` command registers a simulated executable job with this syntax:

```text
add <id> <high|medium|low> <duration_ms> <dependencies|-> <failures_before_success> <max_retries>
```

Use `demo` to opt into a ready-made configuration → database → dataset → report → notification workflow. Its notification job fails once and then succeeds on retry, so retry handling can be observed reproducibly.

The console is also an exploration tool:

- `learn` explains the job lifecycle, graph, queue, workers, retries, and metrics.
- `list` renders the current jobs as a status table.
- `graph` renders the dependency relationships and lifecycle transitions before or after execution.
- `events` displays a timestamped audit trail of every scheduler decision, such as blocking, queueing, retries, and completion.
- `export workflow.dot` produces a Graphviz DOT file that can be rendered with `dot -Tpng workflow.dot -o workflow.png` when Graphviz is installed.
- `demo` now performs deterministic CPU work (configuration validation, checksum calculation, prime indexing, report assembly) instead of only sleeping. The checksum and index branches run concurrently after configuration completes.

## Tests

The self-contained assert test executable covers priority and FIFO ordering, dependency blocking/resolution, retry and permanent failure behavior, duplicate/missing IDs, cycle detection, metrics, concurrent execution, and shutdown through RAII.

```sh
./build/taskforge_tests
```

## Complexity and design notes

Ready selection is `O(log n)` with the priority strategy. Dependency propagation walks only direct dependents; cycle detection is `O(V + E)` per submitted job. A single scheduler mutex protects the graph and state machine, while job functions never run under that mutex. This keeps state transitions straightforward and avoids user code causing scheduler deadlocks.

## Structure

```text
include/     public job, scheduler, strategy, and metrics APIs
src/         scheduler implementation and demo
tests/       deterministic executable test suite
```

Potential extensions: deadlines, delayed jobs, cancellation tokens, persisted job metadata, and configurable logging.
