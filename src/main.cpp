#include "JobScheduler.hpp"
#include <chrono>
#include <iostream>
#include <thread>
using namespace taskforge;
int main(){ JobScheduler s(3); unsigned attempts=0; auto task=[](const char* name,int ms){return [=]{std::cout<<"[Worker] "<<name<<"\n";std::this_thread::sleep_for(std::chrono::milliseconds(ms));return true;};}; s.add({"config","load_configuration",Priority::High,{},0,0,Status::Pending,task("load configuration",60)}); s.add({"database","initialize_database",Priority::High,{"config"},0,0,Status::Pending,task("initialize database",100)}); s.add({"dataset","process_dataset",Priority::Medium,{"database"},0,0,Status::Pending,task("process dataset",140)}); s.add({"report","generate_report",Priority::Low,{"dataset"},0,0,Status::Pending,task("generate report",50)}); s.add({"notify","send_notification",Priority::Medium,{"report"},2,0,Status::Pending,[&]{++attempts;std::cout<<"[Worker] send notification attempt "<<attempts<<"\n";return attempts==2;}}); s.start();s.wait();std::cout<<s.summary(); }
