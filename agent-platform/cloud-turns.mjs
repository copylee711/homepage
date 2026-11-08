import { fail } from './shared.mjs';
import { TurnFanout } from './turn-stream.mjs';

/**
 * One in-flight agent turn owned by the gateway, not by a browser socket.
 * The runner connection and the auth/renew heartbeat stay up after the client
 * leaves. Explicit abort, lost authorization, or the runner finishing the
 * stream are what stop it.
 */
export function createCloudTurns({ runner, identity, heartbeatMs = 10000, renewalGraceMs = 240000 }) {
  const turns = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, turn] of turns) {
      if (turn.finished && turn.retainUntil <= now) turns.delete(key);
    }
  }, 60000);
  sweep.unref?.();

  function keyOf(userId, thread) {
    return userId + '\0' + (thread || '');
  }

  class Turn {
    constructor(userId, token, thread) {
      this.userId = userId;
      this.token = token;
      this.thread = thread;
      this.key = keyOf(userId, thread);
      this.fanout = new TurnFanout();
      this.controller = new AbortController();
      this.finished = false;
      this.policyStop = false;
      this.lastAuthorized = Date.now();
      this.reading = false;
      this.streamLost = false;
      this.retainUntil = 0;
      this.timer = setInterval(() => { void this.heartbeat(); }, heartbeatMs);
      this.timer.unref?.();
    }

    publicStatus() {
      return {
        thread: this.thread,
        busy: !this.finished,
        settled: this.finished && !this.policyStop,
        cursor: this.fanout.cursor,
        policyStopped: this.policyStop === true,
      };
    }

    async heartbeat() {
      if (this.finished || this.beating) return;
      this.beating = true;
      try {
        const current = await identity(this.token);
        if (this.finished) return;
        if (!current.can_execute) this.stopPolicy('执行授权已失效，任务已停止');
        else {
          await runner('/renew', this.userId, { thread: this.thread });
          this.lastAuthorized = Date.now();
        }
      } catch (error) {
        if (this.finished || this.policyStop) return;
        if (error?.status === 401 || error?.status === 403) this.stopPolicy('登录或执行授权已失效，任务已停止');
        else if (Date.now() - this.lastAuthorized >= renewalGraceMs) this.stopPolicy('云端执行授权长时间未能续期，任务已停止');
      } finally { this.beating = false; }
    }

    stopPolicy(message) {
      if (this.policyStop || this.finished) return;
      this.policyStop = true;
      this.fanout.publish(JSON.stringify({ type: 'gateway_error', error: message }) + '\n');
      this.controller.abort();
      if (!this.reading) void this.finishStream();
    }

    failOpen() {
      if (this.finished) return;
      this.finished = true;
      clearInterval(this.timer);
      turns.delete(this.key);
    }

    async finishStream() {
      if (this.finished) return;
      this.finished = true;
      this.streamLost = false;
      clearInterval(this.timer);
      this.fanout.end();
      const path = this.policyStop ? '/abort' : '/cancel';
      await runner(path, this.userId, { thread: this.thread }).catch(() => {});
      this.retainUntil = Date.now() + 30 * 60 * 1000;
    }

    async remoteStatus() {
      try {
        const response = await runner('/turns/status', this.userId, { thread: this.thread });
        return await response.json();
      } catch { return null; }
    }

    async open(payload) {
      return runner('/prompt', this.userId, payload, this.controller.signal);
    }

    attach(res, cursor = 0) {
      if (res.destroyed) return;
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'X-Accel-Buffering': 'no',
        'Cache-Control': 'no-store',
        'X-Turn-Cursor': String(this.fanout.cursor),
      });
      this.fanout.attach(res, cursor, { endIfIdle: this.finished });
      if (this.streamLost && !this.finished) void this.ensurePump();
    }

    async ensurePump() {
      if (this.finished || this.reading || this.pumping) return;
      this.pumping = true;
      try {
        const response = await runner('/turns/subscribe', this.userId, { thread: this.thread, cursor: this.fanout.cursor }, this.controller.signal);
        this.streamLost = false;
        await this.pump(response);
      } catch {
        if (this.policyStop) await this.finishStream();
      } finally { this.pumping = false; }
    }

    async read(response) {
      if (!response?.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (!this.finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            this.fanout.publish(buf.slice(0, idx + 1));
            buf = buf.slice(idx + 1);
            if (buf.length > 8 * 1024 * 1024) buf = buf.slice(-1024 * 1024);
          }
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
      if (!this.finished && buf.trim()) this.fanout.publish(buf.endsWith('\n') ? buf : buf + '\n');
    }

    async pump(response) {
      this.reading = true;
      let clean = false;
      try {
        try {
          await this.read(response);
          clean = !this.policyStop;
        } catch {
          if (this.policyStop || this.controller.signal.aborted) {
            await this.finishStream();
            return;
          }
          const status = await this.remoteStatus();
          if (status?.busy) {
            try {
              const again = await runner('/turns/subscribe', this.userId, { thread: this.thread, cursor: this.fanout.cursor }, this.controller.signal);
              await this.read(again);
              clean = !this.policyStop;
            } catch {
              if (!this.policyStop) {
                this.streamLost = true;
                this.fanout.publish(JSON.stringify({ type: 'gateway_error', error: '与执行器的流已断开，任务仍在云端继续。可重新订阅恢复输出。' }) + '\n');
                this.fanout.end();
              }
              return;
            }
          }
        }
        if (this.finished) return;
        if (this.policyStop) { await this.finishStream(); return; }
        if (clean) { await this.finishStream(); return; }
        const status = await this.remoteStatus();
        if (!status?.busy) await this.finishStream();
        else this.streamLost = true;
      } finally { this.reading = false; }
    }
  }

  return {
    begin({ userId, token, thread }) {
      const key = keyOf(userId, thread);
      const existing = turns.get(key);
      if (existing && !existing.finished) fail(409, '当前任务尚未结束，请先停止或等待完成');
      const turn = new Turn(userId, token, thread);
      turns.set(key, turn);
      return turn;
    },
    get(userId, thread) {
      return turns.get(keyOf(userId, thread));
    },
    abort(userId, thread, message) {
      if (!thread) return this.abortUser(userId, message);
      const turn = turns.get(keyOf(userId, thread));
      if (turn) turn.stopPolicy(message || '任务已停止');
    },
    abortUser(userId, message) {
      for (const turn of turns.values()) {
        if (turn.userId === userId) turn.stopPolicy(message || '任务已停止');
      }
    },
  };
}
