import { execFile } from "node:child_process";
import fs from "node:fs";
import { atomicWrite } from "../util/atomicWrite.js";

const TRANSACTION_RE = /^[0-9a-f]{32}$/;

function nowIso() {
  return new Date().toISOString();
}

function cleanStatus(value) {
  if (!value || typeof value !== "object") return null;
  const status = String(value.status || "");
  if (!["idle", "running", "suspended", "success", "failed"].includes(status)) return null;
  return {
    action: String(value.action || ""),
    status,
    phase: String(value.phase || ""),
    message: String(value.message || ""),
    resumeModel: String(value.resumeModel || ""),
    startedAt: String(value.startedAt || ""),
    updatedAt: String(value.updatedAt || ""),
  };
}

/**
 * Durable facade around Sovereign V2's canonical DGX power lifecycle.
 * SparkDash owns presentation and hardware buttons; the helper remains the
 * sole owner of model drain/stop/start/smoke policy.
 */
export class ClusterPowerCoordinator {
  constructor({ helperPath, statePath, execFileFn = execFile }) {
    this.helperPath = String(helperPath || "").trim();
    this.statePath = statePath;
    this.execFileFn = execFileFn;
    this._resumePromise = null;
    this._status = this._loadStatus();
    if (this._status.status === "running") {
      this._setStatus({
        ...this._status,
        status: "failed",
        phase: "interrupted",
        message: "Dashboard restarted during the power operation; Wake All can retry safely.",
      });
    }
  }

  get configured() {
    if (!this.helperPath) return false;
    try {
      fs.accessSync(this.helperPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  _loadStatus() {
    try {
      return cleanStatus(JSON.parse(fs.readFileSync(this.statePath, "utf8"))) || this._idle();
    } catch {
      return this._idle();
    }
  }

  _idle() {
    return {
      action: "",
      status: "idle",
      phase: "",
      message: "",
      resumeModel: "",
      startedAt: "",
      updatedAt: nowIso(),
    };
  }

  _setStatus(patch) {
    this._status = {
      ...this._status,
      ...patch,
      updatedAt: nowIso(),
    };
    atomicWrite(this.statePath, `${JSON.stringify(this._status, null, 2)}\n`, 0o600);
    return this.status();
  }

  status() {
    return { configured: this.configured, ...this._status };
  }

  async _runHelper(action, timeoutMs) {
    if (!this.configured) {
      throw new Error("DGX cluster power helper is not configured or executable");
    }
    const env = {
      PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: process.env.HOME || "/tmp",
      USER: process.env.USER,
      LOGNAME: process.env.LOGNAME,
      ...(process.env.SOVEREIGN_HOME ? { SOVEREIGN_HOME: process.env.SOVEREIGN_HOME } : {}),
    };
    const output = await new Promise((resolve, reject) => {
      this.execFileFn(
        this.helperPath,
        [action],
        { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            const detail = String(stderr || stdout || error.message).trim().slice(-1200);
            reject(new Error(detail || `${action} failed`));
            return;
          }
          resolve(String(stdout || ""));
        },
      );
    });
    const line = output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).at(-1);
    let payload;
    try {
      payload = JSON.parse(line || "");
    } catch {
      throw new Error(`DGX cluster helper returned invalid JSON for ${action}`);
    }
    if (!payload || payload.action !== action || typeof payload.model !== "string") {
      throw new Error(`DGX cluster helper returned an invalid ${action} receipt`);
    }
    return payload;
  }

  async prepareShutdown() {
    if (this._status.status === "running") {
      throw new Error("Another cluster power operation is already running");
    }
    const startedAt = nowIso();
    this._setStatus({
      action: "shutdown",
      status: "running",
      phase: "draining",
      message: "Draining requests and stopping the active model…",
      resumeModel: "",
      startedAt,
    });
    try {
      const receipt = await this._runHelper("prepare", 15 * 60_000);
      if (!TRANSACTION_RE.test(String(receipt.transaction_id || ""))) {
        throw new Error("DGX cluster helper returned an invalid power transaction id");
      }
      this._setStatus({
        status: "running",
        phase: "poweroff",
        message: `Model ${receipt.model} stopped safely; powering off worker then head…`,
        resumeModel: receipt.model,
      });
      return receipt;
    } catch (error) {
      this._setStatus({
        status: "failed",
        phase: "prepare-failed",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  recordShutdown(results) {
    const failed = results.filter((result) => !result.ok).length;
    return this._setStatus({
      status: failed ? "failed" : "suspended",
      phase: failed ? "partial-poweroff" : "offline",
      message: failed
        ? `${failed} node(s) did not accept shutdown; Wake All will recover the saved model.`
        : "Both DGX nodes accepted shutdown. Wake All will restore the saved model.",
    });
  }

  recordWakeFailure(message) {
    return this._setStatus({
      action: "resume",
      status: "failed",
      phase: "wake-failed",
      message,
    });
  }

  startResume() {
    if (this._resumePromise) return this.status();
    const startedAt = nowIso();
    this._setStatus({
      action: "resume",
      status: "running",
      phase: "waiting-for-hosts",
      message: "Wake packets sent; waiting for both DGX nodes and CX7 before restoring the model…",
      startedAt,
    });
    this._resumePromise = this._runHelper("resume", 90 * 60_000)
      .then((receipt) => {
        const alreadyActive = receipt.changed === false;
        this._setStatus({
          status: "success",
          phase: "ready",
          resumeModel: receipt.model,
          message: alreadyActive
            ? `${receipt.model} is already active; no restore was required.`
            : `${receipt.model} restored and passed readiness checks.`,
        });
        return receipt;
      })
      .catch((error) => {
        this._setStatus({
          status: "failed",
          phase: "resume-failed",
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      })
      .finally(() => {
        this._resumePromise = null;
      });
    return this.status();
  }

  async waitForResumeForTest() {
    return this._resumePromise;
  }
}
