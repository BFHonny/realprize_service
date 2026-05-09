const http = require("http");
const { URL } = require("url");
const { claimDailyBonus, getAccountStatus } = require("./realprize");

function json(response, statusCode, payload, method = "GET") {
  response.writeHead(statusCode, { "content-type": "application/json" });

  if (method === "HEAD") {
    response.end();
    return;
  }

  response.end(JSON.stringify(payload, null, 2));
}

function isAuthorized(requestUrl, requestHeaders) {
  const secret = process.env.CRON_SECRET;

  if (!secret) {
    return true;
  }

  const authorization = requestHeaders.authorization || "";
  const bearerToken = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;

  const queryToken = requestUrl.searchParams.get("token");
  const headerToken = requestHeaders["x-cron-secret"];

  return secret === bearerToken || secret === queryToken || secret === headerToken;
}

async function handleClaim(response, method) {
  try {
    const result = await claimDailyBonus();
    json(response, 200, result, method);
  } catch (error) {
    json(response, 500, { ok: false, error: error.message }, method);
  }
}

async function handleStatus(response, method) {
  try {
    const status = await getAccountStatus();
    json(response, 200, { ok: true, authenticated: true, status }, method);
  } catch (error) {
    json(
      response,
      500,
      {
        ok: false,
        authenticated: false,
        error: error.message,
      },
      method
    );
  }
}

async function runOnce({ statusOnly = false } = {}) {
  try {
    const result = statusOnly ? await getAccountStatus() : await claimDailyBonus();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: error.message,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  }
}

function startServer() {
  const port = Number.parseInt(String(process.env.PORT || 3000), 10);
  const host = process.env.REALPRIZE_HTTP_HOST || "0.0.0.0";

  const server = http.createServer(async (request, response) => {
    if (!["GET", "HEAD", "POST"].includes(request.method || "GET")) {
      return json(
        response,
        405,
        {
          ok: false,
          error: "Method not allowed",
        },
        request.method
      );
    }

    const requestUrl = new URL(request.url, `http://127.0.0.1:${port}`);

    if (requestUrl.pathname === "/") {
      return json(
        response,
        200,
        {
          ok: true,
          service: "realprize-daily-claimer",
          routes: ["/health", "/status", "/claim"],
        },
        request.method
      );
    }

    if (requestUrl.pathname === "/health" || requestUrl.pathname === "/status") {
      return handleStatus(response, request.method);
    }

    if (requestUrl.pathname === "/claim") {
      if (!isAuthorized(requestUrl, request.headers)) {
        return json(
          response,
          401,
          {
            ok: false,
            error: "Unauthorized",
          },
          request.method
        );
      }

      return handleClaim(response, request.method);
    }

    return json(
      response,
      404,
      {
        ok: false,
        error: "Not found",
      },
      request.method
    );
  });

  server.listen(port, host, () => {
    console.log(
      JSON.stringify(
        {
          ok: true,
          listening: port,
          host,
          protected: Boolean(process.env.CRON_SECRET),
        },
        null,
        2
      )
    );
  });
}

if (process.argv.includes("--once")) {
  runOnce();
} else if (process.argv.includes("--status")) {
  runOnce({ statusOnly: true });
} else {
  startServer();
}
