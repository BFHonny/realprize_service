const fs = require("fs");
const path = require("path");
const { createCookieStoreFromEnv } = require("./cookie-store");

const DEFAULT_BASE_URL =
  process.env.REALPRIZE_BASE_URL || "https://realprize.com";

const DEFAULT_REFERER =
  process.env.REALPRIZE_REFERER || "https://realprize.com/";

const DEFAULT_USER_AGENT =
  process.env.REALPRIZE_USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

const DEFAULT_EVENT_ID = "3081716";

const DEFAULT_STATUS_BODY = {
  f: "st",
  first_load: "0",
  p: "casino",
  sportpage: "",
  mbcode: "",
  ingame: "0",
  inchlg: "0",
  cmode: "GCM",
  gl: "0",
  fs: "9",
};

const cookieStore = createCookieStoreFromEnv();

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

function getExtraHeaders() {
  if (!process.env.REALPRIZE_EXTRA_HEADERS_JSON) {
    return {};
  }

  try {
    return JSON.parse(process.env.REALPRIZE_EXTRA_HEADERS_JSON);
  } catch (error) {
    throw new Error(
      `REALPRIZE_EXTRA_HEADERS_JSON is not valid JSON: ${error.message}`
    );
  }
}

function normalizeAuthorization(value) {
  const trimmedValue = String(value || "").trim();

  if (!trimmedValue) {
    return "";
  }

  return /^Bearer\s+/i.test(trimmedValue)
    ? trimmedValue
    : `Bearer ${trimmedValue}`;
}

function hasAuthConfigured(extraHeaders = getExtraHeaders()) {
  return (
    cookieStore.hasCookies() ||
    Boolean(process.env.REALPRIZE_AUTHORIZATION) ||
    Boolean(process.env.REALPRIZE_ACCESS_TOKEN) ||
    Object.keys(extraHeaders).length > 0 ||
    parseBool(process.env.REALPRIZE_ALLOW_NO_AUTH, false)
  );
}

function buildHeaders({ method = "GET", allowMissingAuth = false } = {}) {
  const extraHeaders = getExtraHeaders();

  if (!allowMissingAuth && !hasAuthConfigured(extraHeaders)) {
    throw new Error(
      "No RealPrize auth is configured. Set REALPRIZE_COOKIE or REALPRIZE_EXTRA_HEADERS_JSON. If you intentionally want to probe without auth, set REALPRIZE_ALLOW_NO_AUTH=true."
    );
  }

  const headers = {
    accept: "application/json, text/javascript, */*; q=0.01",
    "accept-language": process.env.REALPRIZE_ACCEPT_LANGUAGE || "de,de-DE;q=0.9,en;q=0.8,en-US;q=0.6",
    referer: DEFAULT_REFERER,
    "user-agent": DEFAULT_USER_AGENT,
    "x-newrelic-id": process.env.REALPRIZE_NEWRELIC_ID || "UgECVlVSARAEUlRaAgIAVFA=",
    "x-requested-with": "XMLHttpRequest",
  };

  if (method === "POST") {
    headers["content-type"] =
      "application/x-www-form-urlencoded; charset=UTF-8";
    headers.origin = new URL(DEFAULT_BASE_URL).origin;
  }

  const cookie = cookieStore.getHeaderString();
  const authorization =
    process.env.REALPRIZE_AUTHORIZATION ||
    normalizeAuthorization(process.env.REALPRIZE_ACCESS_TOKEN);

  if (authorization) {
    headers.authorization = authorization;
  }

  if (cookie) {
    headers.cookie = cookie;
  }

  Object.assign(headers, extraHeaders);

  return headers;
}

function summarizePayload(payload) {
  const type = Array.isArray(payload) ? "array" : typeof payload;
  const keys =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).slice(0, 20)
      : null;
  const snippet = JSON.stringify(payload).slice(0, 500);

  return { type, keys, snippet };
}

function parseRealPrizePayload(rawText, context) {
  let payload;

  try {
    payload = JSON.parse(rawText);
  } catch {
    throw new Error(
      `${context} returned non-JSON: ${rawText.slice(0, 300).replace(/\s+/g, " ")}`
    );
  }

  if (!Array.isArray(payload)) {
    if (payload && typeof payload === "object") {
      return payload.data && typeof payload.data === "object"
        ? payload.data
        : payload;
    }

    throw new Error(
      `${context} returned an unexpected payload shape: ${JSON.stringify(
        summarizePayload(payload)
      )}`
    );
  }

  if (payload.length < 2) {
    throw new Error(
      `${context} returned an unexpected payload shape: ${JSON.stringify(
        summarizePayload(payload)
      )}`
    );
  }

  const [ok, data] = payload;

  if (ok !== 1) {
    throw new Error(`${context} failed: ${JSON.stringify(data)}`);
  }

  return data;
}

async function realPrizeRequest({
  pathName = "/srv.php",
  query = {},
  method = "GET",
  body = null,
  context = "RealPrize request",
}) {
  const url = new URL(pathName, DEFAULT_BASE_URL);

  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, String(value));
    } else if (value === "") {
      url.searchParams.set(name, "");
    }
  }

  const requestOptions = {
    method,
    headers: buildHeaders({ method }),
  };

  if (body) {
    requestOptions.body = new URLSearchParams(body).toString();
  }

  const response = await fetch(url, requestOptions);
  cookieStore.captureResponseCookies(response.headers);

  const rawText = await response.text();

  if (!response.ok) {
    throw new Error(
      `${context} failed with ${response.status}: ${rawText.slice(0, 300).replace(/\s+/g, " ")}`
    );
  }

  return parseRealPrizePayload(rawText, context);
}

function readEventIdFromFile() {
  const eventIdFile = process.env.REALPRIZE_EVENT_ID_FILE;

  if (!eventIdFile) {
    return "";
  }

  try {
    return fs.readFileSync(path.resolve(eventIdFile), "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(
        `${new Date().toISOString()} WARN: Could not read event id file ${eventIdFile}: ${error.message}`
      );
    }

    return "";
  }
}

function writeEventIdToFile(eventId) {
  const eventIdFile = process.env.REALPRIZE_EVENT_ID_FILE;

  if (!eventIdFile || !eventId) {
    return;
  }

  const filePath = path.resolve(eventIdFile);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${eventId}\n`, "utf8");
}

function getConfiguredEventId() {
  return String(
    process.env.REALPRIZE_EVENT_ID || readEventIdFromFile() || DEFAULT_EVENT_ID
  ).trim();
}

async function getAccountStatus() {
  return realPrizeRequest({
    pathName: "/srv.php",
    query: { stat: "" },
    method: "POST",
    body: DEFAULT_STATUS_BODY,
    context: "RealPrize status",
  });
}

async function claimDailyPrize({ eventId } = {}) {
  const query = {
    w: "",
    f: "dailyprizeclaim",
    type: "day",
  };

  if (eventId) {
    query.eventId = eventId;
  }

  return realPrizeRequest({
    pathName: "/srv.php",
    query,
    method: "GET",
    context: "RealPrize daily prize claim",
  });
}

function getClaimSummary(claimResponse) {
  const event = claimResponse && claimResponse.event;
  const todayPrize =
    event && event.prizes && event.prizes.today ? event.prizes.today : null;

  return {
    eventId: event && event.id,
    userId: event && event.userId,
    status: event && event.status,
    startAt: event && event.startAt,
    endAt: event && event.endAt,
    current: event && event.current,
    claimedCount: event && event.claimedCount,
    collected: event && event.collected,
    todayStatus: todayPrize && todayPrize.status,
  };
}

async function claimDailyBonus() {
  const statusBefore = await getAccountStatus().catch((error) => ({
    error: error.message,
  }));
  const configuredEventId = getConfiguredEventId();
  const claimResponse = await claimDailyPrize({ eventId: configuredEventId });

  const claimSummary = getClaimSummary(claimResponse);

  if (claimSummary.eventId) {
    writeEventIdToFile(claimSummary.eventId);
  }

  const statusAfter = await getAccountStatus().catch((error) => ({
    error: error.message,
  }));

  return {
    ok: true,
    action: claimSummary.todayStatus === "claimed" ? "claimed" : "checked",
    usedEventId: configuredEventId || null,
    retriedWithoutEventId: false,
    statusBefore,
    statusAfter,
    claimResponse,
    claimSummary,
  };
}

module.exports = {
  claimDailyBonus,
  claimDailyPrize,
  getAccountStatus,
  getClaimSummary,
};
