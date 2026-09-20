#pragma once
#include "Job.hpp"
#include <memory>
#include <queue>

namespace taskforge {
class SchedulingStrategy {
 public:
  virtual ~SchedulingStrategy() = default;
  virtual void push(const JobId& id, Priority priority, std::uint64_t order) = 0;
  virtual JobId pop() = 0;
  virtual bool empty() const = 0;
};
class PrioritySchedulingStrategy final : public SchedulingStrategy {
  struct Entry { JobId id; Priority priority; std::uint64_t order; };
  struct Compare { bool operator()(const Entry& a, const Entry& b) const { return a.priority != b.priority ? a.priority < b.priority : a.order > b.order; } };
  std::priority_queue<Entry, std::vector<Entry>, Compare> queue_;
 public:
  void push(const JobId& id, Priority priority, std::uint64_t order) override { queue_.push({id, priority, order}); }
  JobId pop() override { auto id = queue_.top().id; queue_.pop(); return id; }
  bool empty() const override { return queue_.empty(); }
};
class FIFOSchedulingStrategy final : public SchedulingStrategy {
  std::queue<JobId> queue_;
 public:
  void push(const JobId& id, Priority, std::uint64_t) override { queue_.push(id); }
  JobId pop() override { auto id = queue_.front(); queue_.pop(); return id; }
  bool empty() const override { return queue_.empty(); }
};
}
