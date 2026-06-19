# Vercel Python Serverless Function: /api/ubicquia
# Replica el flujo del script Python que descarga todas las columnas.
# Usa variables de entorno:
# UBICQUIA_<PANEL>_CLIENT_ID
# UBICQUIA_<PANEL>_CLIENT_SECRET
# Opcional: UBICQUIA_ACCESS_CODE o ACCESS_CODE o DOWNLOAD_CODE

from http.server import BaseHTTPRequestHandler
import os
import json
import requests
from urllib.parse import quote

TOKEN_URL = "https://auth.ubihub.ubicquia.com/auth/realms/ubivu-prd/protocol/openid-connect/token"
DTM_METRIX_URL = "https://api.ubicquia.com/api/ubigrid/transformer/metrix/list"
NOTIFICATIONS_URL = "https://api.ubicquia.com/api/v2/notification-nodes"
PER_PAGE = 20000
MAX_PAGES = 100
BACKEND_VERSION = "python-backend-v1-exact-reference-flow"


def response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type, x-access-code")
    handler.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
    handler.end_headers()
    handler.wfile.write(body)


def get_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length else b"{}"
    return json.loads(raw.decode("utf-8") or "{}")


def check_access(handler):
    expected = os.environ.get("UBICQUIA_ACCESS_CODE") or os.environ.get("ACCESS_CODE") or os.environ.get("DOWNLOAD_CODE")
    if not expected:
        return True
    got = handler.headers.get("x-access-code")
    return got == expected


def get_credentials(panel):
    key = str(panel or "646703").strip()
    return key, os.environ.get(f"UBICQUIA_{key}_CLIENT_ID"), os.environ.get(f"UBICQUIA_{key}_CLIENT_SECRET")


def get_access_token(client_id, client_secret):
    auth_data = {
        "grant_type": "client_credentials",
        "scope": "openid",
        "client_id": client_id,
        "client_secret": client_secret,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    r = requests.post(TOKEN_URL, data=auth_data, headers=headers, timeout=60)
    r.raise_for_status()
    token = r.json().get("access_token")
    if not token:
        raise RuntimeError("Auth response did not include access_token")
    return token


def fetch_api_data_paginated(url, headers, data):
    all_data = []
    page = 1
    while page <= MAX_PAGES:
        payload = dict(data)
        payload["page"] = page
        payload["per_page"] = str(PER_PAGE)
        r = requests.post(url, headers=headers, json=payload, timeout=90)
        r.raise_for_status()
        page_data = r.json().get("data", [])
        if not page_data:
            break
        all_data.extend(page_data)
        page += 1
    return all_data


def fetch_notifications_paginated(notification_type, start_date, end_date, access_token, imei, subpanel_id):
    headers_api = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
        "current-subpanel-id": str(subpanel_id),
    }
    all_notifications = []
    page = 1
    while page <= MAX_PAGES:
        url = (
            f"{NOTIFICATIONS_URL}?type=transformers"
            f"&start_date={quote(start_date)}&end_date={quote(end_date)}"
            f"&notification_type={quote(notification_type)}&page={page}&per_page={PER_PAGE}"
        )
        r = requests.get(url, headers=headers_api, timeout=90)
        r.raise_for_status()
        page_data = r.json().get("data", {}).get("nodes", [])
        if not page_data:
            break
        all_notifications.extend(page_data)
        page += 1
    return [n for n in all_notifications if str(n.get("dev_eui")) == str(imei)]


def safely_parse_json(x):
    if x is None:
        return {}
    if isinstance(x, dict):
        return x
    try:
        return json.loads(x)
    except Exception:
        try:
            return json.loads(str(x).replace("''", '"').replace("“", '"').replace("”", '"'))
        except Exception:
            return {}


def add_msg_fields(rows):
    out = []
    for r in rows or []:
        item = dict(r)
        parsed = safely_parse_json(item.get("jsonData"))
        item["MsgStr"] = parsed.get("msgStr")
        item["MsgType"] = parsed.get("msgType")
        out.append(item)
    return out


def filter_power_loss(rows):
    out = []
    for r in add_msg_fields(rows):
        if r.get("MsgStr") in ["AlertPowerLoss", "AlertPowerLoss2"] or r.get("alertvalue") == "Loss":
            out.append(r)
    return out


def filter_power_restored(rows):
    out = []
    for r in add_msg_fields(rows):
        if r.get("MsgStr") == "AlertPowerRestored" or r.get("alertvalue") == "Restored":
            out.append(r)
    return out


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        response(self, 200, {"ok": True})

    def do_POST(self):
        try:
            if not check_access(self):
                response(self, 401, {"error": "Invalid access code"})
                return

            body = get_body(self)
            action = body.get("action", "all")
            if action != "all":
                response(self, 400, {"error": "Only action=all is supported"})
                return

            imei = str(body.get("imei", "")).strip()
            start = body.get("start")
            end = body.get("end")
            subpanel_id = str(body.get("subpanel_id") or "0")
            panel = body.get("panel") or "646703"

            if not imei or not start or not end:
                response(self, 400, {"error": "Missing imei, start or end"})
                return

            panel_key, client_id, client_secret = get_credentials(panel)
            if not client_id or not client_secret:
                response(self, 500, {"error": f"Missing credentials for panel {panel_key}"})
                return

            token = get_access_token(client_id, client_secret)
            headers_api = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "current-subpanel-id": subpanel_id,
            }

            post_data = {
                "start_datetime": start,
                "end_datetime": end,
                "imei": imei,
                "serialNumber": imei,
                "type": "voltage",
                "page": "1",
                "per_page": str(PER_PAGE),
            }

            metrix = fetch_api_data_paginated(DTM_METRIX_URL, headers_api, post_data)
            sag = fetch_notifications_paginated("AlertAggregatedVoltageSag", start, end, token, imei, subpanel_id)
            swell = fetch_notifications_paginated("AlertAggregatedVoltageSwell120/240/277V", start, end, token, imei, subpanel_id)
            loss_raw = fetch_notifications_paginated("AlertPowerLoss", start, end, token, imei, subpanel_id)
            restored_raw = fetch_notifications_paginated("AlertPowerRestored", start, end, token, imei, subpanel_id)

            powerloss = filter_power_loss(loss_raw)
            powerrestored = filter_power_restored(restored_raw)

            response(self, 200, {
                "data": {
                    "backendVersion": BACKEND_VERSION,
                    "metrix": metrix,
                    "sag": sag,
                    "swell": swell,
                    "powerloss": powerloss,
                    "powerrestored": powerrestored,
                    "counts": {
                        "metrix": len(metrix),
                        "sag": len(sag),
                        "swell": len(swell),
                        "powerloss": len(powerloss),
                        "powerrestored": len(powerrestored),
                    }
                }
            })
        except Exception as e:
            response(self, 500, {"error": str(e)})
