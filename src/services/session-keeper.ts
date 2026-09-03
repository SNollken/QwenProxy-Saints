import { config } from "../core/config.ts";
import {
  closeIdlePlaywrightAccounts,
  getActivePlaywrightAccountIds,
  keepAlivePlaywrightAccount,
} from "./playwright.ts";
import { humanDelay, sleep } from "./human-behavior.ts";
import { getAccountRequestCount } from "../core/account-concurrency.ts";
import { getAccountCooldownInfo } from "../core/account-manager.ts";

let running = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let pendingCycle: Promise<void> | null = null;
let prepareMissingAccounts: (() => Promise<void>) | undefined;

export function isSessionKeeperRunning(): boolean {
  return running;
}

async function performKeepAliveCycle(): Promise<void> {
    if (config.sessionKeeper.enabled) {
      await prepareMissingAccounts?.();
      const accountIds = getActivePlaywrightAccountIds();
      for (const accountId of accountIds) {
        if (getAccountRequestCount(accountId) > 0 || getAccountCooldownInfo(accountId)) continue;
        await keepAlivePlaywrightAccount(accountId).catch((error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            !message.includes("Target closed") &&
            !message.includes("Page is closed")
          ) {
            console.warn(
              `[SessionKeeper] Keep-alive failed for ${accountId}: ${message}`,
            );
          }
        });
        await sleep(humanDelay(250, 900));
      }
    }

    const closed = await closeIdlePlaywrightAccounts(
      config.playwright.idleContextTtlMs,
    );
    if (closed > 0) {
      console.log(
        `🧹 [SessionKeeper] Closed ${closed} idle Playwright context(s)`,
      );
    }
}

function runKeepAliveCycle(): Promise<void> {
  if (pendingCycle) return pendingCycle;
  const cycle = performKeepAliveCycle();
  pendingCycle = cycle;
  const finished = () => {
    if (pendingCycle === cycle) pendingCycle = null;
  };
  void cycle.then(finished, finished);
  return cycle;
}

export function startSessionKeeper(options?: {
  prepareMissingAccounts?: () => Promise<void>;
}): void {
  const hasKeepAliveWork = config.sessionKeeper.enabled;
  const hasIdleCleanupWork = config.playwright.idleContextTtlMs > 0;
  if (running || (!hasKeepAliveWork && !hasIdleCleanupWork)) return;

  running = true;
  prepareMissingAccounts = options?.prepareMissingAccounts;
  intervalId = setInterval(() => {
    if (running) void runKeepAliveCycle().catch((error) => {
      console.warn("[SessionKeeper] Cycle failed:", error instanceof Error ? error.message : String(error));
    });
  }, config.sessionKeeper.intervalMs);
  intervalId.unref?.();

  if (config.sessionKeeper.enabled) {
    console.log(
      `💓 [SessionKeeper] Keep-alive enabled | interval=${config.sessionKeeper.intervalMs}ms idle=${config.sessionKeeper.idleMs}ms`,
    );
  }
}

export async function stopSessionKeeper(): Promise<void> {
  running = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  prepareMissingAccounts = undefined;
  await pendingCycle;
}

export async function runSessionKeeperOnceForTesting(): Promise<void> {
  await runKeepAliveCycle();
}
