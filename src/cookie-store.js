const fs = require("fs");
const path = require("path");

function splitCombinedSetCookieHeader(headerValue) {
  return headerValue
    .split(/,(?=[^;,\s]+=)/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function extractSetCookieHeaders(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (Array.isArray(values) && values.length > 0) {
      return values;
    }
  }

  const combinedHeader =
    typeof headers.get === "function" ? headers.get("set-cookie") : null;

  return combinedHeader ? splitCombinedSetCookieHeader(combinedHeader) : [];
}

class CookieStore {
  constructor({ cookieHeader, cookieFile }) {
    this.cookies = new Map();
    this.cookieFile = cookieFile ? path.resolve(cookieFile) : null;

    if (cookieHeader) {
      this.mergeCookieHeader(cookieHeader);
    }

    if (this.cookieFile && fs.existsSync(this.cookieFile)) {
      this.mergeCookieHeader(fs.readFileSync(this.cookieFile, "utf8"));
    }

    if (this.cookieFile && this.hasCookies()) {
      this.persist();
    }
  }

  mergeCookieHeader(cookieHeader) {
    for (const cookiePart of String(cookieHeader).split(";")) {
      const trimmedPart = cookiePart.trim();

      if (!trimmedPart) {
        continue;
      }

      const separatorIndex = trimmedPart.indexOf("=");
      if (separatorIndex <= 0) {
        continue;
      }

      const name = trimmedPart.slice(0, separatorIndex).trim();
      const value = trimmedPart.slice(separatorIndex + 1).trim();

      if (name) {
        this.cookies.set(name, value);
      }
    }
  }

  mergeSetCookie(setCookieHeader) {
    const [cookieDefinition] = String(setCookieHeader).split(";");

    if (!cookieDefinition) {
      return;
    }

    const separatorIndex = cookieDefinition.indexOf("=");
    if (separatorIndex <= 0) {
      return;
    }

    const name = cookieDefinition.slice(0, separatorIndex).trim();
    const value = cookieDefinition.slice(separatorIndex + 1).trim();

    if (!name) {
      return;
    }

    if (value) {
      this.cookies.set(name, value);
    } else {
      this.cookies.delete(name);
    }
  }

  captureResponseCookies(headers) {
    const setCookieHeaders = extractSetCookieHeaders(headers);

    if (setCookieHeaders.length === 0) {
      return;
    }

    for (const setCookieHeader of setCookieHeaders) {
      this.mergeSetCookie(setCookieHeader);
    }

    this.persist();
  }

  getHeaderString() {
    return [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  hasCookies() {
    return this.cookies.size > 0;
  }

  persist() {
    if (!this.cookieFile) {
      return;
    }

    fs.mkdirSync(path.dirname(this.cookieFile), { recursive: true });
    fs.writeFileSync(this.cookieFile, `${this.getHeaderString()}\n`, "utf8");
  }
}

function createCookieStoreFromEnv() {
  return new CookieStore({
    cookieHeader: process.env.REALPRIZE_COOKIE,
    cookieFile: process.env.REALPRIZE_COOKIE_FILE,
  });
}

module.exports = {
  createCookieStoreFromEnv,
};
