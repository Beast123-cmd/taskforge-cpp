#include "JobScheduler.hpp"

#include <algorithm>
#include <functional>
#include <sstream>
#include <stdexcept>

namespace taskforge {

const char* to_string(Status status) {
  switch (status) {
    case Status::Pending: return "PENDING";
    case Status::Blocked: return "BLOCKED";
    case Status::Ready: return "READY";
    case Status::Running: return "RUNNING";
    case Status::Completed: return "COMPLETED";
    case Status::Failed: return "FAILED";
    case Status::Cancelled: return "CANCELLED";
  }
  return "UNKNOWN";
}

const char* to_string(Priority priority) {
  return priority == Priority::High ? "HIGH" :
         priority == Priority::Medium ? "MEDIUM" : "LOW";
}

void MetricsCollector::submitted() { std::lock_guard<std::mutex> lock(mutex_); ++data_.submitted; }
void MetricsCollector::started(std::chrono::milliseconds wait) { std::lock_guard<std::mutex> lock(mutex_); ++data_.running; data_.peak_running = std::max(data_.peak_running, data_.running); data_.total_wait += wait; }
void MetricsCollector::finished(bool success, std::chrono::milliseconds run) { std::lock_guard<std::mutex> lock(mutex_); --data_.running; success ? ++data_.completed : ++data_.failed; data_.total_run += run; }
void MetricsCollector::retried() { std::lock_guard<std::mutex> lock(mutex_); --data_.running; ++data_.retries; }
Metrics MetricsCollector::snapshot() const { std::lock_guard<std::mutex> lock(mutex_); return data_; }

JobScheduler::JobScheduler(std::size_t workers, std::unique_ptr<SchedulingStrategy> strategy)
    : strategy_(std::move(strategy)), worker_count_(workers) {
  if (workers == 0 || !strategy_) throw std::invalid_argument("a scheduler needs workers and a strategy");
}

JobScheduler::~JobScheduler() { stop(); }

bool JobScheduler::cycle_if_added_locked(const Job& candidate) const {
  auto edges = dependents_;
  for (const auto& dependency : candidate.dependencies) edges[dependency].push_back(candidate.id);
  std::unordered_map<JobId, int> color;
  std::function<bool(const JobId&)> visit = [&](const JobId& id) {
    if (color[id] == 1) return true;  // A DFS back edge is a cycle.
    if (color[id] == 2) return false;
    color[id] = 1;
    for (const auto& child : edges[id]) if (visit(child)) return true;
    color[id] = 2;
    return false;
  };
  for (const auto& pair : jobs_) if (visit(pair.first)) return true;
  return visit(candidate.id);
}

void JobScheduler::add(Job job) {
  std::lock_guard<std::mutex> lock(mutex_);
  if (started_) throw std::logic_error("cannot add jobs after start");
  if (job.id.empty() || !job.task) throw std::invalid_argument("a job needs an id and executable task");
  if (jobs_.count(job.id)) throw std::invalid_argument("duplicate job id: " + job.id);
  if (cycle_if_added_locked(job)) throw std::invalid_argument("dependency cycle detected");
  job.submitted_at = std::chrono::steady_clock::now();
  const JobId id = job.id;
  jobs_.emplace(id, std::move(job));
  submission_order_.push_back(id);
  for (const auto& dependency : jobs_.at(id).dependencies) dependents_[dependency].push_back(id);
  metrics_.submitted();
}

void JobScheduler::evaluate_locked(const JobId& id) {
  Job& job = jobs_.at(id);
  if (job.status == Status::Ready || job.status == Status::Running || job.status == Status::Completed || job.status == Status::Failed || job.status == Status::Cancelled) return;
  for (const auto& dependency : job.dependencies) {
    const Status state = jobs_.at(dependency).status;
    if (state == Status::Failed || state == Status::Cancelled) {
      job.status = Status::Cancelled;
      for (const auto& child : dependents_[id]) evaluate_locked(child);
      return;
    }
    if (state != Status::Completed) { job.status = Status::Blocked; return; }
  }
  job.status = Status::Ready;
  strategy_->push(id, job.priority, order_++);
  work_available_.notify_one();
}

void JobScheduler::start() {
  std::lock_guard<std::mutex> lock(mutex_);
  if (started_) throw std::logic_error("scheduler already started");
  for (const auto& pair : jobs_)
    for (const auto& dependency : pair.second.dependencies)
      if (!jobs_.count(dependency)) throw std::invalid_argument("missing dependency for " + pair.first + ": " + dependency);
  started_ = true;
  for (const auto& id : submission_order_) evaluate_locked(id);
  for (std::size_t i = 0; i < worker_count_; ++i) workers_.emplace_back(&JobScheduler::worker, this);
}

bool JobScheduler::terminal_locked() const {
  for (const auto& pair : jobs_)
    if (pair.second.status != Status::Completed && pair.second.status != Status::Failed && pair.second.status != Status::Cancelled) return false;
  return active_ == 0;
}

void JobScheduler::worker() {
  for (;;) {
    JobId id;
    JobFunction task;
    std::chrono::steady_clock::time_point started_at;
    {
      std::unique_lock<std::mutex> lock(mutex_);
      work_available_.wait(lock, [&] { return stopping_ || !strategy_->empty() || terminal_locked(); });
      if (stopping_ || (strategy_->empty() && terminal_locked())) return;
      id = strategy_->pop();
      Job& job = jobs_.at(id);
      if (job.status != Status::Ready) continue;
      job.status = Status::Running;
      started_at = job.started_at = std::chrono::steady_clock::now();
      ++active_;
      metrics_.started(std::chrono::duration_cast<std::chrono::milliseconds>(started_at - job.submitted_at));
      task = job.task;
    }
    // Arbitrary client work must never execute while scheduler state is locked.
    bool success = false;
    try { success = task(); } catch (...) { success = false; }
    const auto ended_at = std::chrono::steady_clock::now();
    complete(id, success, std::chrono::duration_cast<std::chrono::milliseconds>(ended_at - started_at));
  }
}

void JobScheduler::complete(const JobId& id, bool success, std::chrono::milliseconds duration) {
  std::lock_guard<std::mutex> lock(mutex_);
  Job& job = jobs_.at(id);
  --active_;
  job.run_time = duration;
  if (success) {
    job.status = Status::Completed;
    metrics_.finished(true, duration);
    for (const auto& child : dependents_[id]) evaluate_locked(child);
  } else if (job.retries < job.max_retries) {
    ++job.retries;
    job.status = Status::Ready;
    strategy_->push(id, job.priority, order_++);
    metrics_.retried();
    work_available_.notify_one();
  } else {
    job.status = Status::Failed;
    metrics_.finished(false, duration);
    for (const auto& child : dependents_[id]) evaluate_locked(child);
  }
  if (terminal_locked()) { work_finished_.notify_all(); work_available_.notify_all(); }
}

void JobScheduler::wait() {
  std::unique_lock<std::mutex> lock(mutex_);
  if (!started_) throw std::logic_error("scheduler not started");
  work_finished_.wait(lock, [&] { return terminal_locked() || stopping_; });
}

void JobScheduler::stop() {
  { std::lock_guard<std::mutex> lock(mutex_);
    if (!stopping_) { stopping_ = true; for (auto& pair : jobs_) if (pair.second.status == Status::Pending || pair.second.status == Status::Blocked || pair.second.status == Status::Ready) pair.second.status = Status::Cancelled; } }
  work_available_.notify_all();
  work_finished_.notify_all();
  for (auto& thread : workers_) if (thread.joinable()) thread.join();
  workers_.clear();
}

Status JobScheduler::status(const JobId& id) const { std::lock_guard<std::mutex> lock(mutex_); return jobs_.at(id).status; }
Job JobScheduler::job(const JobId& id) const { std::lock_guard<std::mutex> lock(mutex_); return jobs_.at(id); }
std::vector<Job> JobScheduler::jobs() const { std::lock_guard<std::mutex> lock(mutex_); std::vector<Job> result; result.reserve(submission_order_.size()); for (const auto& id : submission_order_) result.push_back(jobs_.at(id)); return result; }
Metrics JobScheduler::metrics() const { return metrics_.snapshot(); }

std::string JobScheduler::summary() const {
  const Metrics data = metrics();
  const std::size_t terminal = data.completed + data.failed;
  std::ostringstream out;
  out << "========= Execution Summary =========\n"
      << "Jobs submitted: " << data.submitted << "\nJobs completed: " << data.completed
      << "\nJobs failed: " << data.failed << "\nRetries: " << data.retries
      << "\nCurrent running jobs: " << data.running
      << "\nAverage wait time: " << (terminal ? data.total_wait.count() / terminal : 0) << " ms"
      << "\nAverage run time: " << (terminal ? data.total_run.count() / terminal : 0) << " ms"
      << "\nPeak concurrent jobs: " << data.peak_running << "\n";
  return out.str();
}

}  // namespace taskforge
