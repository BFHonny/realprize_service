const http = require("http");
const https = require("https");
const { claimDailyBonus } = require("./realprize");

const ENV_PREFIX = "REALPRIZE_";
const DEFAULT_CONFIG = {
  timezone: "Europe/Zurich",
  checkIntervalSec: 900,
  successIntervalSec: 86400,
  exitOnAuthFailure: true,
  heartbeatEnabled: true,
  heartbeatUrl: "https://realprize.com",
  heartbeatIntervalSec: 540,
  heartbeatTimeoutSec: 2,
  sleepChunkSec: 300,
};

const HEALTH_SERVER_HOST = process.env.REALPRIZE_HTTP_HOST || "0.0.0.0";
const HEARTBEAT_USER_AGENT = "realprize-heartbeat";

function readEnv(name, defaultValue = undefined) {
  return process.env[`${ENV_PREFIX}${name}`] ?? defaultValue;
}

function parseBool(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const normalizedValue = String(value).trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  return defaultValue;
}

function parseIntWithDefault(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsedValue = Number.parseInt(String(value), 10);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : defaultValue;
}

function parseFloatWithDefault(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }

  const parsedValue = Number.parseFloat(String(value));
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? parsedValue
    : defaultValue;
}

function loadConfig() {
  return {
    timezone: readEnv("TIMEZONE", DEFAULT_CONFIG.timezone),
    checkIntervalSec: parseIntWithDefault(
      readEnv("CHECK_INTERVAL_SEC"),
      DEFAULT_CONFIG.checkIntervalSec
    ),
    successIntervalSec: parseIntWithDefault(
      readEnv("SUCCESS_INTERVAL_SEC"),
      DEFAULT_CONFIG.successIntervalSec
    ),
    exitOnAuthFailure: parseBool(
      readEnv("EXIT_ON_AUTH_FAILURE"),
      DEFAULT_CONFIG.exitOnAuthFailure
    ),
    heartbeatEnabled: parseBool(
      readEnv("HEARTBEAT_ENABLED"),
      DEFAULT_CONFIG.heartbeatEnabled
    ),
    heartbeatUrl: readEnv("HEARTBEAT_URL", DEFAULT_CONFIG.heartbeatUrl),
    heartbeatIntervalSec: parseIntWithDefault(
      readEnv("HEARTBEAT_INTERVAL_SEC"),
      DEFAULT_CONFIG.heartbeatIntervalSec
    ),
    heartbeatTimeoutSec: parseFloatWithDefault(
      readEnv("HEARTBEAT_TIMEOUT_SEC"),
      DEFAULT_CONFIG.heartbeatTimeoutSec
    ),
    sleepChunkSec: parseIntWithDefault(
      readEnv("SLEEP_CHUNK_SEC"),
      DEFAULT_CONFIG.sleepChunkSec
    ),
  };
}

function log(level, message, details) {
  const renderedDetails =
    details === undefined ? "" : ` ${JSON.stringify(details)}`;
  console.log(
    `${formatTimestamp(Date.now())} ${level.toUpperCase()}: ${message}${renderedDetails}`
  );
}

function formatTimestamp(timestamp) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: process.env.TZ || DEFAULT_CONFIG.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  return `${formatter.format(new Date(timestamp))} ${
    process.env.TZ || DEFAULT_CONFIG.timezone
  }`;
}

function looksLikeAuthFailure(error) {
  const message = String(error && error.message ? error.message : error);

  return (
    /No RealPrize auth is configured/i.test(message) ||
    /\b401\b/.test(message) ||
    /\b403\b/.test(message) ||
    /Just a moment/i.test(message) ||
    /Cloudflare/i.test(message) ||
    /unauthori[sz]ed/i.test(message) ||
    /forbidden/i.test(message) ||
    /auth/i.test(message)
  );
}

function getNextDelayMs(result, config) {
  if (result && result.ok) {
    return config.successIntervalSec * 1000;
  }

  return config.checkIntervalSec * 1000;
}

function summarizeStatus(status) {
  if (!status || status.error) {
    return status || null;
  }

  return {
    balance: status.balance,
    bonus: status.bonus,
    fun_casino_balance: status.fun_casino_balance,
    redeemable_balance: status.redeemable_balance,
    unredeemable_balance: status.unredeemable_balance,
    vip_points: status.vip_points,
  };
}

function summarizeResult(result) {
  return {
    action: result.action,
    ok: result.ok,
    usedEventId: result.usedEventId,
    retriedWithoutEventId: result.retriedWithoutEventId,
    claimSummary: result.claimSummary,
    statusBefore: summarizeStatus(result.statusBefore),
    statusAfter: summarizeStatus(result.statusAfter),
  };
}

function serializeError(error) {
  return {
    message: error && error.message ? error.message : String(error),
    at: new Date().toISOString(),
  };
}

function createRuntimeState() {
  return {
    startedAt: new Date().toISOString(),
    status: "starting",
    shutdownRequested: false,
    shutdownSignal: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastResult: null,
    nextWakeAt: null,
  };
}

function setNextWake(runtimeState, nextWakeTimestamp) {
  runtimeState.nextWakeAt = Number.isFinite(nextWakeTimestamp)
    ? new Date(nextWakeTimestamp).toISOString()
    : null;
}

function createShutdownState() {
  let requested = false;
  let signal = null;
  const listeners = new Set();

  return {
    isRequested() {
      return requested;
    },
    getSignal() {
      return signal;
    },
    onRequest(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request(nextSignal) {
      if (requested) {
        return false;
      }

      requested = true;
      signal = nextSignal;

      for (const listener of listeners) {
        listener(nextSignal);
      }

      listeners.clear();
      return true;
    },
  };
}

function installSignalHandlers(shutdownState, runtimeState) {
  const handleSignal = (signal) => {
    if (!shutdownState.request(signal)) {
      return;
    }

    runtimeState.shutdownRequested = true;
    runtimeState.shutdownSignal = signal;
    runtimeState.status = "stopping";

    log("info", "Shutdown requested.", { signal });
  };

  process.on("SIGTERM", () => {
    handleSignal("SIGTERM");
  });

  process.on("SIGINT", () => {
    handleSignal("SIGINT");
  });
}

function writeJson(response, statusCode, payload, method) {
  response.writeHead(statusCode, { "content-type": "application/json" });

  if (method === "HEAD") {
    response.end();
    return;
  }

  response.end(JSON.stringify(payload, null, 2));
}

function buildHealthPayload(config, runtimeState) {
  return {
    ok: true,
    service: "realprize-daily-worker",
    timezone: config.timezone,
    status: runtimeState.status,
    startedAt: runtimeState.startedAt,
    shutdownRequested: runtimeState.shutdownRequested,
    shutdownSignal: runtimeState.shutdownSignal,
    lastAttemptAt: runtimeState.lastAttemptAt,
    lastSuccessAt: runtimeState.lastSuccessAt,
    nextWakeAt: runtimeState.nextWakeAt,
    lastResult: runtimeState.lastResult,
    lastError: runtimeState.lastError,
  };
}

function startHealthServer(config, runtimeState) {
  const port = Number.parseInt(String(process.env.PORT || ""), 10);

  if (!Number.isFinite(port) || port <= 0) {
    return Promise.resolve({
      close: () => Promise.resolve(),
    });
  }

  const server = http.createServer((request, response) => {
    if (!["GET", "HEAD"].includes(request.method || "GET")) {
      return writeJson(
        response,
        405,
        {
          ok: false,
          error: "Method not allowed",
        },
        request.method
      );
    }

    if (
      request.url === "/" ||
      request.url === "/health" ||
      request.url === "/ready"
    ) {
      return writeJson(
        response,
        200,
        buildHealthPayload(config, runtimeState),
        request.method
      );
    }

    return writeJson(
      response,
      404,
      {
        ok: false,
        error: "Not found",
      },
      request.method
    );
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HEALTH_SERVER_HOST, () => {
      server.removeListener("error", reject);
      log("info", "Health server listening.", {
        host: HEALTH_SERVER_HOST,
        port,
        routes: ["/health", "/ready"],
      });

      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error) {
                closeReject(error);
                return;
              }

              closeResolve();
            });
          }),
      });
    });
  });
}

async function sleepMs(totalMs, chunkMs, shutdownState) {
  let remainingMs = Math.max(0, totalMs);

  while (remainingMs > 0 && !shutdownState.isRequested()) {
    const nextChunkMs = Math.min(remainingMs, chunkMs);

    await new Promise((resolve) => {
      const timer = setTimeout(finish, nextChunkMs);
      const unsubscribe = shutdownState.onRequest(() => {
        clearTimeout(timer);
        finish();
      });

      function finish() {
        unsubscribe();
        resolve();
      }
    });

    remainingMs -= nextChunkMs;
  }
}

function startHeartbeat(config) {
  if (!config.heartbeatEnabled || !config.heartbeatUrl) {
    log("info", "Heartbeat disabled.");
    return () => {};
  }

  const intervalMs = Math.max(60, config.heartbeatIntervalSec) * 1000;
  const timeoutMs = Math.max(0.5, config.heartbeatTimeoutSec) * 1000;

  let heartbeatUrl;
  try {
    heartbeatUrl = new URL(config.heartbeatUrl);
  } catch (error) {
    log("error", "Heartbeat disabled because URL is invalid.", {
      url: config.heartbeatUrl,
      error: error.message,
    });
    return () => {};
  }

  const protocolToAgent = {
    "http:": new http.Agent({ keepAlive: true }),
    "https:": new https.Agent({ keepAlive: true }),
  };
  const heartbeatAgent = protocolToAgent[heartbeatUrl.protocol];

  if (!heartbeatAgent) {
    log("error", "Heartbeat disabled because URL protocol is unsupported.", {
      url: config.heartbeatUrl,
      protocol: heartbeatUrl.protocol,
    });
    return () => {};
  }

  function sendHeartbeat() {
    return new Promise((resolve, reject) => {
      const transport = heartbeatUrl.protocol === "https:" ? https : http;
      const request = transport.request(
        heartbeatUrl,
        {
          agent: heartbeatAgent,
          headers: {
            "user-agent": HEARTBEAT_USER_AGENT,
          },
          method: "HEAD",
        },
        (response) => {
          response.resume();
          resolve();
        }
      );

      request.setTimeout(timeoutMs, () => {
        request.destroy(new Error(`Heartbeat timed out after ${timeoutMs}ms`));
      });
      request.on("error", reject);
      request.end();
    });
  }

  let stopped = false;
  let timer = null;

  log("info", "Heartbeat enabled.", {
    url: config.heartbeatUrl,
    intervalSec: intervalMs / 1000,
    timeoutSec: timeoutMs / 1000,
    userAgent: HEARTBEAT_USER_AGENT,
  });

  const runHeartbeatLoop = async () => {
    if (stopped) {
      return;
    }

    try {
      await sendHeartbeat();
    } catch (error) {
      log("debug", "Heartbeat failed.", { error: error.message });
    }

    if (stopped) {
      return;
    }

    timer = setTimeout(() => {
      void runHeartbeatLoop();
    }, intervalMs);
  };

  void runHeartbeatLoop();

  return () => {
    stopped = true;

    if (timer) {
      clearTimeout(timer);
    }

    for (const agent of Object.values(protocolToAgent)) {
      agent.destroy();
    }
  };
}

async function main() {
  const config = loadConfig();
  process.env.TZ = config.timezone;
  const runtimeState = createRuntimeState();
  const shutdownState = createShutdownState();
  installSignalHandlers(shutdownState, runtimeState);

  log("info", "Worker starting.", {
    timezone: config.timezone,
    checkIntervalSec: config.checkIntervalSec,
    successIntervalSec: config.successIntervalSec,
    exitOnAuthFailure: config.exitOnAuthFailure,
  });

  const healthServer = await startHealthServer(config, runtimeState);
  const stopHeartbeat = startHeartbeat(config);

  const sleepChunkMs = Math.max(1, config.sleepChunkSec) * 1000;

  try {
    while (!shutdownState.isRequested()) {
      runtimeState.status = "running";
      runtimeState.lastAttemptAt = new Date().toISOString();

      try {
        const result = await claimDailyBonus();
        const nextDelayMs = getNextDelayMs(result, config);
        const nextWakeTimestamp = Date.now() + nextDelayMs;

        runtimeState.lastResult = summarizeResult(result);
        runtimeState.lastError = null;
        runtimeState.lastSuccessAt = new Date().toISOString();
        runtimeState.status = "sleeping";
        setNextWake(runtimeState, nextWakeTimestamp);

        log("info", "Claim loop completed.", runtimeState.lastResult);
        log("info", "Next check scheduled.", {
          wakeAt: formatTimestamp(nextWakeTimestamp),
          inSec: Math.round(nextDelayMs / 1000),
        });

        await sleepMs(nextDelayMs, sleepChunkMs, shutdownState);
      } catch (error) {
        const authFailureDetected = looksLikeAuthFailure(error);
        const retryDelayMs = config.checkIntervalSec * 1000;
        const retryWakeTimestamp = Date.now() + retryDelayMs;

        runtimeState.lastError = {
          ...serializeError(error),
          authFailureDetected,
        };
        runtimeState.status = authFailureDetected ? "auth-failed" : "error";
        setNextWake(runtimeState, authFailureDetected ? null : retryWakeTimestamp);

        log("error", "Claim loop failed.", { error: error.message });

        if (config.exitOnAuthFailure && authFailureDetected) {
          log("error", "Exiting because auth failure was detected.");
          process.exitCode = 1;
          break;
        }

        log("info", "Retry scheduled.", {
          wakeAt: formatTimestamp(retryWakeTimestamp),
          inSec: Math.round(retryDelayMs / 1000),
        });

        await sleepMs(retryDelayMs, sleepChunkMs, shutdownState);
      }
    }
  } finally {
    runtimeState.status = "stopping";
    runtimeState.shutdownRequested =
      runtimeState.shutdownRequested || shutdownState.isRequested();
    runtimeState.shutdownSignal =
      runtimeState.shutdownSignal || shutdownState.getSignal();
    setNextWake(runtimeState, null);

    stopHeartbeat();
    await healthServer.close();

    log("info", "Worker stopped.", {
      signal: runtimeState.shutdownSignal,
      exitCode: process.exitCode || 0,
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    log("error", "Worker crashed.", { error: error.message });
    process.exit(1);
  });
}

module.exports = {
  getNextDelayMs,
  loadConfig,
  looksLikeAuthFailure,
};
