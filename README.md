# RealPrize Daily Service (Railway-ready)

Dieser Service holt den RealPrize Daily Prize ab und laeuft als langlebiger Railway-Worker. Er pollt nicht jede Minute: nach einem erfolgreichen Claim wartet er standardmaessig 24 Stunden und sendet nur einen separaten Heartbeat, damit Railway nicht einschlaeft.

## Was aus der HAR-Datei belegt ist

Der Daily-Prize-Claim lief ueber:

- `GET https://realprize.com/srv.php?w&f=dailyprizeclaim&type=day&eventId=3081716`
- Status/Wallet lief ueber `POST https://realprize.com/srv.php?stat`
- Die Claim-Antwort war ein Array `[1, {...}]` und enthielt `event.prizes.today.status = "claimed"` sowie Rewards wie `gc` und `sc`.

Die HAR enthaelt keine sichtbaren `cookie`- oder `authorization`-Header. Ein Request ohne Browser-Session wird aber von Cloudflare mit `403` geblockt. Deshalb muss die echte Browser-Session in Railway als Env gesetzt werden.

## Konfiguration

Setze diese Variablen in Railway oder lokal per Env:

| Variable | Beschreibung | Default |
| --- | --- | --- |
| `REALPRIZE_COOKIE` | Kompletter `cookie`-Header aus dem eingeloggten Browser. Wichtig bei Cloudflare. | leer |
| `REALPRIZE_COOKIE_FILE` | Datei fuer Cookie-Persistenz, falls RealPrize `Set-Cookie` liefert. | leer |
| `REALPRIZE_AUTHORIZATION` | Kompletter `authorization`-Header aus dem Browser, falls vorhanden. | leer |
| `REALPRIZE_ACCESS_TOKEN` | Reiner Token; der Service setzt automatisch `Bearer `. | leer |
| `REALPRIZE_EXTRA_HEADERS_JSON` | Fallback fuer weitere Header als JSON. | leer |
| `REALPRIZE_EVENT_ID` | Daily-Event-ID aus der HAR. | `3081716` |
| `REALPRIZE_EVENT_ID_FILE` | Datei, in der die zuletzt erfolgreiche Event-ID gespeichert wird. | `/tmp/realprize-event-id.txt` |
| `REALPRIZE_ALLOW_NO_AUTH` | Nur fuer Tests ohne Session. | `false` |
| `REALPRIZE_TIMEZONE` | Zeitzone fuer Worker-Logs. | `Europe/Zurich` |
| `REALPRIZE_CHECK_INTERVAL_SEC` | Fallback-Intervall bei Fehlern. | `900` |
| `REALPRIZE_SUCCESS_INTERVAL_SEC` | Wartezeit nach erfolgreichem Claim. | `86400` |
| `REALPRIZE_EXIT_ON_AUTH_FAILURE` | Prozess bei Auth-/Cloudflare-Fehler mit Exit-Code `1` beenden. | `true` |
| `REALPRIZE_HEARTBEAT_ENABLED` | Kleinen HEAD-Heartbeat senden, damit Railway Serverless nicht einschlaeft. | `true` |
| `REALPRIZE_HEARTBEAT_URL` | Ziel fuer den Heartbeat. | `https://realprize.com` |
| `REALPRIZE_HEARTBEAT_INTERVAL_SEC` | Heartbeat-Intervall. | `540` |
| `REALPRIZE_HEARTBEAT_TIMEOUT_SEC` | Heartbeat-Timeout. | `2` |
| `REALPRIZE_SLEEP_CHUNK_SEC` | Maximaler Sleep-Chunk des Workers. | `300` |
| `REALPRIZE_BASE_URL` | RealPrize Base URL. | `https://realprize.com` |
| `REALPRIZE_REFERER` | Referer passend zur HAR. | `https://realprize.com/` |
| `PORT` | Aktiviert den Health-Endpoint des Workers. | leer |

## Railway-Minimum

```text
REALPRIZE_COOKIE=<voller cookie header aus dem srv.php request>
REALPRIZE_EVENT_ID=3081716
REALPRIZE_EVENT_ID_FILE=/tmp/realprize-event-id.txt
REALPRIZE_SUCCESS_INTERVAL_SEC=86400
REALPRIZE_HEARTBEAT_INTERVAL_SEC=540
```

RealPrize verlangt eine Event-ID. Der Service nutzt `3081716` als Fallback, falls `REALPRIZE_EVENT_ID` und `REALPRIZE_EVENT_ID_FILE` leer sind. Erfolgreiche Claims speichern die aktuelle `event.id` in `REALPRIZE_EVENT_ID_FILE`.

## Lokale Nutzung

Einmaliger Claim:

```bash
npm run claim
```

Nur Status lesen:

```bash
npm run status
```

Laufender Worker:

```bash
npm start
```

## Session aus dem Browser holen

1. RealPrize im Browser eingeloggt oeffnen.
2. DevTools -> Network.
3. Einen Request auf `https://realprize.com/srv.php?stat` oder den Claim-Request `srv.php?w&f=dailyprizeclaim...` anklicken.
4. Unter Request Headers den kompletten `cookie:` Wert kopieren.
5. In Railway als `REALPRIZE_COOKIE` setzen.
6. Falls dort ein `authorization:` Header steht, diesen als `REALPRIZE_AUTHORIZATION` setzen.

Wenn Chrome keinen Cookie-Header im Network-Panel zeigt:

1. DevTools -> Application -> Cookies -> `https://realprize.com`.
2. Alle relevanten Session-/Cloudflare-Cookies als `name=value; name2=value2` zusammensetzen.
3. Dabei besonders auf Cookies wie `PHPSESSID`, `cf_clearance`, `__cf_bm` oder andere Session-Cookies achten.

Der Heartbeat ist nur ein HEAD-Request und loest keinen Claim aus. Claims passieren nur im Worker-Loop oder explizit ueber `/claim`.
