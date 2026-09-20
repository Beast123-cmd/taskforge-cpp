#pragma once
#include "Job.hpp"
#include "MetricsCollector.hpp"
#include "SchedulingStrategy.hpp"
#include <condition_variable>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_map>

namespace taskforge {
class JobScheduler {
 public:
  explicit JobScheduler(std::size_t workers, std::unique_ptr<SchedulingStrategy> strategy = std::make_unique<PrioritySchedulingStrategy>());
  ~JobScheduler();
  JobScheduler(const JobScheduler&) = delete; JobScheduler& operator=(const JobScheduler&) = delete;
  void add(Job job); void start(); void wait(); void stop();
  Status status(const JobId& id) const; Job job(const JobId& id) const; Metrics metrics() const; std::string summary() const;
 private:
  void worker(); void evaluate_locked(const JobId& id); void complete(const JobId& id, bool success, std::chrono::milliseconds duration);
  bool cycle_if_added_locked(const Job& candidate) const; bool terminal_locked() const;
  mutable std::mutex mutex_; std::condition_variable cv_, done_cv_;
  std::unordered_map<JobId, Job> jobs_; std::unordered_map<JobId, std::vector<JobId>> dependents_; std::vector<JobId> submission_order_;
  std::unique_ptr<SchedulingStrategy> strategy_; std::vector<std::thread> workers_; MetricsCollector metrics_; std::uint64_t order_{0};
  bool started_{false}, stopping_{false}; std::size_t active_{0}, worker_count_;
};
}
