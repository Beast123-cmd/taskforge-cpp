#include "JobScheduler.hpp"
#include "ProcessRunner.hpp"
#include <atomic>
#ifdef NDEBUG
#undef NDEBUG  // Keep test assertions active in Release CI builds.
#endif
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <thread>
#include <vector>
using namespace taskforge;
static Job make(const char* id, Priority p, std::vector<JobId> deps, JobFunction f, unsigned retries=0){return {id,id,p,std::move(deps),retries,0,Status::Pending,std::move(f)};}
int main(){
 assert(run_executable("node", {"-e", "process.exit(process.argv[1] === 'a b;$(echo injected)' && process.argv[2] === '' && process.argv[3] === 'quote\" slash\\\\' && process.argv[4] === 'a b & %PATH% ^ test' ? 0 : 5)", "a b;$(echo injected)", "", "quote\" slash\\", "a b & %PATH% ^ test"}) == 0);
 assert(run_executable("taskforge-nonexistent-executable", {}) == -1);
 { std::vector<std::string> order;std::mutex m;JobScheduler s(1);auto f=[&](const char* x){return [&,x]{std::lock_guard<std::mutex>l(m);order.push_back(x);return true;};};s.add(make("low",Priority::Low,{},f("low")));s.add(make("high",Priority::High,{},f("high")));s.add(make("medium",Priority::Medium,{},f("medium")));s.start();s.wait();assert((order==std::vector<std::string>{"high","medium","low"})); }
 { std::vector<std::string> o;JobScheduler s(1);auto f=[&](const char* x){return [&,x]{o.push_back(x);return true;};};s.add(make("a",Priority::High,{},f("a")));s.add(make("b",Priority::High,{},f("b")));s.start();s.wait();assert((o==std::vector<std::string>{"a","b"})); }
 { std::atomic<int>x{0};JobScheduler s(2);s.add(make("a",Priority::Low,{},[&]{x=1;return true;}));s.add(make("b",Priority::High,{"a"},[&]{assert(x==1);return true;}));s.start();s.wait();assert(s.status("b")==Status::Completed); }
 { JobScheduler s(1);s.add(make("a",Priority::High,{},[]{return false;}));s.add(make("b",Priority::High,{"a"},[]{return true;}));s.start();s.wait();assert(s.status("a")==Status::Failed&&s.status("b")==Status::Cancelled); }
 { unsigned n=0;JobScheduler s(1);s.add(make("a",Priority::High,{},[&]{return ++n==3;},2));s.start();s.wait();assert(n==3&&s.metrics().retries==2&&s.status("a")==Status::Completed); }
 { JobScheduler s(1);s.add(make("a",Priority::High,{},[]{return true;}));bool threw=false;try{s.add(make("a",Priority::High,{},[]{return true;}));}catch(const std::invalid_argument&){threw=true;}assert(threw); }
 { std::atomic<int> running{0},peak{0};JobScheduler s(3);for(int i=0;i<6;++i)s.add(make(("j"+std::to_string(i)).c_str(),Priority::Medium,{},[&]{auto v=++running;peak=std::max(peak.load(),v);std::this_thread::sleep_for(std::chrono::milliseconds(20));--running;return true;}));s.start();s.wait();assert(peak>1&&s.metrics().peak_running>1); }
 { JobScheduler s(1);s.add(make("a",Priority::High,{},[]{return true;}));s.start();s.wait();bool tagged=false;for(const auto& event:s.events())if(event.status==Status::Running&&event.worker_id==1)tagged=true;assert(tagged);assert(s.finished());assert(s.events_since(0).size()==s.events().size());assert(s.events_since(s.events().size()).empty()); }
 { JobScheduler s(1);s.add(make("a",Priority::High,{},[]{return true;}));s.add(make("b",Priority::High,{"missing"},[]{return true;}));bool threw=false;try{s.start();}catch(const std::invalid_argument&){threw=true;}assert(threw); }
 { JobScheduler s(1);s.add(make("a",Priority::High,{"c"},[]{return true;}));s.add(make("b",Priority::High,{"a"},[]{return true;}));bool threw=false;try{s.add(make("c",Priority::High,{"b"},[]{return true;}));}catch(const std::invalid_argument&){threw=true;}assert(threw); }
 { std::mutex m;std::condition_variable cv;bool running=false,release=false;JobScheduler s(1);s.add(make("a",Priority::High,{},[&]{std::unique_lock<std::mutex>l(m);running=true;cv.notify_one();cv.wait(l,[&]{return release;});return true;}));s.start();{std::unique_lock<std::mutex>l(m);cv.wait(l,[&]{return running;});release=true;}cv.notify_one();s.stop();assert(s.status("a")==Status::Completed); }
 std::cout<<"All TaskForge tests passed\n";
}
