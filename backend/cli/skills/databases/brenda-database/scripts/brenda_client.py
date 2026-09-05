"""Small SOAP bridge for the operations used by the bundled BRENDA helpers.

Contract: https://www.brenda-enzymes.org/soap.php (Python 3 / Zeep examples).
Importing this module neither reads credentials nor opens a network connection.
"""

import hashlib
import os
import threading
import time


WSDL = "https://www.brenda-enzymes.org/soap/brenda_zeep.wsdl"
_lock = threading.Lock()
_last_request = None
_client = None
_FIELDS = {
    "getKmValue": ("ecNumber", "organism", "kmValue", "kmValueMaximum", "substrate", "commentary", "ligandStructureId", "literature"),
    "getReaction": ("ecNumber", "reaction", "commentary", "literature", "organism"),
}


def _records(response):
    """Keep the legacy helper format while accepting Zeep's structured rows."""
    if response is None:
        return []
    if isinstance(response, str):
        return [row for row in response.split("!") if row.strip()]
    from zeep.helpers import serialize_object
    rows = serialize_object(response)
    if isinstance(rows, dict):
        rows = [rows]
    result = []
    for row in rows:
        if isinstance(row, str):
            result.extend(_records(row))
            continue
        fields = []
        for key, value in row.items():
            if value is None:
                value = ""
            if isinstance(value, list):
                value = ",".join(str(item) for item in value)
            fields.append(f"{key}*{value}")
        result.append("#".join(fields))
    return result


def _query(method, **filters):
    global _client, _last_request
    email = os.environ.get("BRENDA_EMAIL") or os.environ.get("BRENDA_EMIAL")
    password = os.environ.get("BRENDA_PASSWORD")
    if not email or not password:
        raise RuntimeError("Set BRENDA_EMAIL and BRENDA_PASSWORD for a registered BRENDA SOAP account.")
    try:
        from zeep import Client, Settings
        from zeep.transports import Transport
    except ImportError as error:
        raise ImportError("BRENDA SOAP requires zeep. Install it with: uv pip install zeep") from error
    arguments = [email, hashlib.sha256(password.encode("utf-8")).hexdigest()]
    arguments.extend(f"{field}*{filters.get(field) or ''}" for field in _FIELDS[method])
    # BRENDA requests at most one call per second. Serialize callers as well as
    # pacing them; the high-level helpers alone do not cover concurrent use.
    with _lock:
        if _client is None:
            _client = Client(WSDL, settings=Settings(strict=False), transport=Transport(timeout=30, operation_timeout=30))
        if _last_request is not None:
            time.sleep(max(0.0, 1.0 - (time.monotonic() - _last_request)))
        _last_request = time.monotonic()
        return _records(getattr(_client.service, method)(*arguments))


def get_km_values(ec_number, organism=None, substrate=None):
    return _query("getKmValue", ecNumber=ec_number, organism=organism, substrate=substrate)


def get_reactions(ec_number, organism=None, reaction=None):
    return _query("getReaction", ecNumber=ec_number, organism=organism, reaction=reaction)
