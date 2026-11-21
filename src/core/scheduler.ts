import { SimpleIntervalJob, ToadScheduler } from 'toad-scheduler';
import { logInfo } from './logger';

export interface ScheduledJob {
  id: string;
  label: string;
  job: SimpleIntervalJob;
  init?: () => void;
}

class SchedulerManager {
  private scheduler = new ToadScheduler();

  private jobs = new Map<string, { meta: ScheduledJob; running: boolean }>();

  loadJobs(list: ScheduledJob[]) {
    for (const item of list) {
      item.init?.();
      this.scheduler.addSimpleIntervalJob(item.job);
      this.jobs.set(item.id, { meta: item, running: true });
    }
    logInfo('Scheduler', `已加载 ${list.length} 个定时任务`);
  }

  startById(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    entry.meta.init?.();
    this.scheduler.startById(id);
    entry.running = true;
    logInfo('Scheduler', `任务 ${id} 已启动`);
    return true;
  }

  stopById(id: string): boolean {
    const entry = this.jobs.get(id);
    if (!entry) return false;
    this.scheduler.stopById(id);
    entry.running = false;
    logInfo('Scheduler', `任务 ${id} 已停止`);
    return true;
  }

  listJobs() {
    return [...this.jobs.values()].map(({ meta, running }) => ({
      id: meta.id,
      label: meta.label,
      running,
    }));
  }

  stopAll() {
    this.scheduler.stop();
  }
}

export default new SchedulerManager();
