import * as logger from "../logger";

function _backoff(retryNumber: number, delay: number): Promise<void> {
  return new Promise((resolve: () => void) => {
    setTimeout(resolve, delay * Math.pow(2, retryNumber));
  });
}

function DEFAULT_HANDLER(task: any): Promise<any> {
  return (task as () => Promise<any>)();
}

export interface ThrottlerOptions<T> {
  name?: string;
  concurrency?: number;
  handler?: (task: T) => Promise<any>;
  retries?: number;
  backoff?: number;
}

export interface ThrottlerStats {
  max: number;
  min: number;
  avg: number;
  active: number;
  complete: number;
  success: number;
  errored: number;
  retried: number;
  total: number;
  elapsed: number;
}

interface TaskData<T> {
  task: T;
  retryCount: number;
  wait: { resolve: (result: any) => void; reject: (err: Error) => void } | undefined;
}

export abstract class Throttler<T> {
  public name: string = "";
  public concurrency: number = 200;
  public handler: (task: T) => Promise<any> = DEFAULT_HANDLER;
  public active: number = 0;
  public complete: number = 0;
  public success: number = 0;
  public errored: number = 0;
  public retried: number = 0;
  public total: number = 0;
  public taskDatas: { [index: number]: TaskData<T> } = {};
  public waits: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  public min: number = 9999999999;
  public max: number = 0;
  public avg: number = 0;
  public retries: number = 0;
  public backoff: number = 200;
  public closed: boolean = false;
  public finished: boolean = false;
  public startTime: number = 0;

  constructor(options: ThrottlerOptions<T>) {
    if (options.name) {
      this.name = options.name;
    }
    if (options.handler) {
      this.handler = options.handler;
    }
    if (typeof options.concurrency === "number") {
      this.concurrency = options.concurrency;
    }
    if (typeof options.retries === "number") {
      this.retries = options.retries;
    }
    if (typeof options.backoff === "number") {
      this.backoff = options.backoff;
    }
    if (typeof options.backoff === "number") {
      this.backoff = options.backoff;
    }
  }

  /**
   * @return `true` if there are unscheduled task waiting to be scheduled.
   */
  public abstract hasWaitingTask(): boolean;

  /**
   * @return the index of the next task to schedule.
   */
  public abstract nextWaitingTaskIndex(): number;

  public wait(): Promise<void> {
    const p = new Promise<void>((resolve, reject) => {
      this.waits.push({ resolve, reject });
    });
    return p;
  }

  /**
   * Add the task to the throttler, which eventually gets executed.
   */
  public add(task: T, wait?: { resolve: () => void; reject: (err: Error) => void }): void {
    if (this.closed) {
      throw new Error("Cannot add a task to a closed throttler.");
    }
    if (!this.startTime) {
      this.startTime = Date.now();
    }
    this.taskDatas[this.total] = {
      task,
      wait,
      retryCount: 0,
    };
    this.total++;
    this.process();
  }

  /**
   * Add the task to the throttler and return a promise of handler's result.
   */
  public throttle<R>(task: T): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.add(task, { resolve, reject });
    });
  }

  public close(): boolean {
    this.closed = true;
    return this._finishIfIdle();
  }

  public process(): void {
    if (this._finishIfIdle() || this.active >= this.concurrency || !this.hasWaitingTask()) {
      return;
    }

    this.active++;
    this.handle(this.nextWaitingTaskIndex());
  }

  public async handle(cursorIndex: number): Promise<void> {
    const taskData = this.taskDatas[cursorIndex];
    const task = taskData.task;
    const tname = this.taskName(cursorIndex);
    const t0 = Date.now();

    try {
      const result = await this.handler(task);
      const dt = Date.now() - t0;
      if (dt < this.min) {
        this.min = dt;
      }
      if (dt > this.max) {
        this.max = dt;
      }
      this.avg = (this.avg * this.complete + dt) / (this.complete + 1);

      this.success++;
      this.complete++;
      this.active--;
      if (taskData.wait) {
        taskData.wait.resolve(result);
      }
      delete this.taskDatas[cursorIndex];
      this.process();
    } catch (err) {
      if (this.retries > 0) {
        if (taskData.retryCount < this.retries) {
          taskData.retryCount++;
          this.retried++;
          await _backoff(taskData.retryCount, this.backoff);
          logger.debug(`[${this.name}] Retrying task`, tname);
          return this.handle(cursorIndex);
        }
      }

      this.errored++;
      this.complete++;
      this.active--;
      if (taskData.retryCount > 0) {
        logger.debug(`[${this.name}] Retries exhausted for task ${tname}:`, err);
      } else {
        logger.debug(`[${this.name}] Error on task ${tname}:`, err);
      }
      if (taskData.wait) {
        taskData.wait.reject(err);
      }
      this._finish(err);
    }
  }

  public stats(): ThrottlerStats {
    return {
      max: this.max,
      min: this.min,
      avg: this.avg,
      active: this.active,
      complete: this.complete,
      success: this.success,
      errored: this.errored,
      retried: this.retried,
      total: this.total,
      elapsed: Date.now() - this.startTime,
    };
  }

  public taskName(cursorIndex: number): string {
    const taskData = this.taskDatas[cursorIndex];
    if (!taskData) {
      return "finished task";
    }
    return typeof taskData.task === "string" ? taskData.task : `index ${cursorIndex}`;
  }

  private _finishIfIdle(): boolean {
    if (this.closed && !this.hasWaitingTask() && this.active === 0) {
      this._finish(null);
      return true;
    }

    return false;
  }

  private _finish(err: Error | null): void {
    this.waits.forEach((p) => {
      if (err) {
        return p.reject(err);
      }
      this.finished = true;
      return p.resolve();
    });
  }
}
