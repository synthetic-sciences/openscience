"""Hermetic behavioral checks for bundled database scripts (standard library only)."""

import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import os
import re
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch
import xml.etree.ElementTree as ET
from urllib.parse import parse_qs, urlparse


SKILLS = Path(__file__).resolve().parents[3] / "skills"


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, SKILLS / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Brenda(unittest.TestCase):
    def setUp(self):
        self.location = SKILLS / "databases/brenda-database/scripts"
        self.path = patch.object(sys, "path", [str(self.location)] + sys.path)
        self.path.start()
        self.addCleanup(self.path.stop)
        self.client = load("test_brenda_client", "databases/brenda-database/scripts/brenda_client.py")

    def test_all_bundled_python_scripts_compile(self):
        for file in SKILLS.rglob("*.py"):
            with self.subTest(file=str(file.relative_to(SKILLS))):
                compile(file.read_bytes(), str(file), "exec")

    def test_query_and_pathway_modules_import_without_network(self):
        with patch("socket.create_connection", side_effect=AssertionError("unexpected network")):
            queries = load("test_brenda_queries", "databases/brenda-database/scripts/brenda_queries.py")
            pathway = load("test_brenda_pathway", "databases/brenda-database/scripts/enzyme_pathway_builder.py")
        self.assertTrue(queries.BRENDA_CLIENT_AVAILABLE)
        self.assertTrue(pathway.BRENDA_QUERIES_AVAILABLE)
        parsed = queries.parse_km_entry("organism*Fixture#kmValue*1.2#commentary*pH 7.4, 25°C")
        self.assertEqual(parsed["km_value_numeric"], 1.2)

    def test_documented_package_imports_resolve_bundled_siblings(self):
        package = types.ModuleType("brenda_fixture")
        package.__path__ = [str(self.location)]
        with patch.dict(sys.modules, {"brenda_fixture": package}):
            queries = __import__("brenda_fixture.brenda_queries", fromlist=["parse_km_entry"])
            pathway = __import__("brenda_fixture.enzyme_pathway_builder", fromlist=["BRENDA_QUERIES_AVAILABLE"])
        self.assertTrue(queries.BRENDA_CLIENT_AVAILABLE)
        self.assertTrue(pathway.BRENDA_QUERIES_AVAILABLE)

    def test_activation_mechanisms_and_deduplication(self):
        queries = load("test_brenda_queries", "databases/brenda-database/scripts/brenda_queries.py")
        rows = [
            "organism*A#commentary*Activated by Mg2+, allosteric cofactor",
            "organism*B#commentary*Enhanced by Mn2+ as cofactor",
            "organism*C#commentary*Stimulated by DTT",
        ]
        with patch.object(queries, "validate_dependencies"), patch.object(queries, "get_km_values", create=True, return_value=rows + rows), patch.object(queries.time, "sleep"):
            result = queries.get_activators("1.1.1.1")
        self.assertEqual([row["mechanism"] for row in result], ["allosteric", "cofactor", "unknown"])
        self.assertEqual([row["organism"] for row in result], ["A", "B", "C"])

    def test_soap_order_hash_normalization_and_pacing(self):
        service = Mock()
        service.getKmValue.return_value = [{"organism": "Fixture", "kmValue": 1.2, "literature": [10, 20]}]
        service.getReaction.return_value = "reaction*A + B <=> C!reaction*D -> E"
        self.client._client = types.SimpleNamespace(service=service)
        modules = {
            "zeep": types.SimpleNamespace(Client=Mock(), Settings=Mock()),
            "zeep.transports": types.SimpleNamespace(Transport=Mock()),
            "zeep.helpers": types.SimpleNamespace(serialize_object=lambda value: value),
        }
        with patch.dict(sys.modules, modules), patch.dict(os.environ, {"BRENDA_EMAIL": "fixture@example.invalid", "BRENDA_PASSWORD": "fixture-password"}, clear=True), patch.object(self.client.time, "monotonic", return_value=10), patch.object(self.client.time, "sleep") as sleep:
            rows = self.client.get_km_values("1.1.1.1", organism="Fixture", substrate="ethanol")
            reactions = self.client.get_reactions("1.1.1.1", organism="Fixture", reaction="ethanol")
        digest = hashlib.sha256(b"fixture-password").hexdigest()
        service.getKmValue.assert_called_once_with("fixture@example.invalid", digest, "ecNumber*1.1.1.1", "organism*Fixture", "kmValue*", "kmValueMaximum*", "substrate*ethanol", "commentary*", "ligandStructureId*", "literature*")
        service.getReaction.assert_called_once_with("fixture@example.invalid", digest, "ecNumber*1.1.1.1", "reaction*ethanol", "commentary*", "literature*", "organism*Fixture")
        self.assertEqual(rows, ["organism*Fixture#kmValue*1.2#literature*10,20"])
        self.assertEqual(reactions, ["reaction*A + B <=> C", "reaction*D -> E"])
        sleep.assert_called_once_with(1.0)

    def test_missing_credentials_stops_before_network(self):
        with patch.dict(os.environ, {}, clear=True), patch("socket.create_connection", side_effect=AssertionError("unexpected network")):
            with self.assertRaisesRegex(RuntimeError, "BRENDA_EMAIL"):
                self.client.get_km_values("1.1.1.1")


XML = '<drugbank xmlns="http://www.drugbank.ca"><drug type="small molecule"><drugbank-id primary="true">DB00001</drugbank-id><name>Fixture drug</name><drug-interactions><drug-interaction><drugbank-id>DB00002</drugbank-id><name>Other fixture</name><description>Fixture interaction</description></drug-interaction></drug-interactions></drug></drugbank>'


class DrugBank(unittest.TestCase):
    def setUp(self):
        self.helper = load("test_drugbank", "databases/drugbank-database/scripts/drugbank_helper.py").DrugBankHelper
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.file = Path(self.temp.name) / "fixture.xml"
        self.file.write_text(XML)

    def test_local_xml_is_lazy_cached_and_searchable(self):
        db = self.helper(xml_path=self.file)
        self.assertIsNone(db.root)
        self.assertEqual(db.get_drug_info("DB00001")["name"], "Fixture drug")
        self.assertEqual(db.get_interactions("DB00001")[0]["partner_id"], "DB00002")
        self.file.unlink()
        self.assertEqual(db.get_drug_info("DB00001")["name"], "Fixture drug")
        self.assertEqual(db.get_drug_info("DB99999"), {})

    def test_explicit_path_precedes_environment_and_root_stays_supported(self):
        with patch.dict(os.environ, {"DRUGBANK_XML_PATH": "missing.xml"}):
            self.assertEqual(self.helper(xml_path=self.file).get_drug_info("DB00001")["name"], "Fixture drug")
            self.assertEqual(self.helper(root=ET.fromstring(XML)).get_drug_info("DB00001")["name"], "Fixture drug")
        with patch.dict(os.environ, {"DRUGBANK_XML_PATH": str(self.file)}):
            self.assertEqual(self.helper().get_drug_info("DB00001")["name"], "Fixture drug")

    def test_setup_errors_are_distinct_from_absent_records(self):
        with self.assertRaisesRegex(ValueError, "DRUGBANK_XML_PATH"):
            self.helper().get_drug_info("DB00001")
        with self.assertRaises(FileNotFoundError):
            self.helper(xml_path=self.file.with_name("missing.xml")).get_drug_info("DB00001")
        for data, expected in [("not XML", "could not be parsed"), ("<other/>", "not a DrugBank export")]:
            self.file.write_text(data)
            with self.assertRaisesRegex(ValueError, expected):
                self.helper(xml_path=self.file).get_drug_info("DB00001")
        with self.assertRaises(ValueError):
            self.helper(root=ET.fromstring(XML), xml_path=self.file)


class OpenTargets(unittest.TestCase):
    def setUp(self):
        self.post = Mock()
        self.response = Mock()
        self.post.return_value = self.response
        requests = types.SimpleNamespace(post=self.post, exceptions=types.SimpleNamespace(RequestException=OSError))
        with patch.dict(sys.modules, {"requests": requests}):
            self.api = load("test_opentargets", "databases/opentargets-database/scripts/query_opentargets.py")

    def response_data(self, data):
        self.response.json.return_value = {"data": data}

    def test_all_helpers_handle_absent_entities(self):
        self.response_data({"search": None, "target": None, "disease": None, "drug": None})
        self.assertEqual(self.api.search_entities("missing"), [])
        self.assertEqual(self.api.get_target_info("missing", True), {})
        self.assertEqual(self.api.get_disease_info("missing", True), {})
        self.assertEqual(self.api.get_target_disease_evidence("missing", "missing"), [])
        self.assertEqual(self.api.get_known_drugs_for_disease("missing"), {})
        self.assertEqual(self.api.get_drug_info("missing"), {})
        self.assertEqual(self.api.get_target_associations("missing"), [])
        pages = []
        for call in self.post.call_args_list:
            query = call.kwargs["json"]["query"]
            for literal in re.findall(r"\bpage\s*:\s*\{([^}]+)\}", query):
                fields = dict(re.findall(r"(\w+)\s*:\s*(-?\d+)", literal))
                self.assertEqual(set(fields), {"index", "size"})
                self.assertEqual(int(fields["index"]), 0)
                pages.append(int(fields["size"]))
        self.assertEqual(pages, [10, 10, 10, 100])

    def test_evidence_filter_preserves_datatype_semantics(self):
        rows = [{"datatypeId": "genetic_association", "datasourceId": "gwas_credible_sets"}, {"datatypeId": "known_drug", "datasourceId": "chembl"}]
        self.response_data({"disease": {"evidences": {"rows": rows}}})
        self.assertEqual(self.api.get_target_disease_evidence("target", "disease", ["genetic_association"]), rows[:1])
        self.assertEqual(self.post.call_args.kwargs["json"]["variables"], {"ensemblId": "target", "efoId": "disease"})
        self.assertEqual(self.post.call_args.kwargs["timeout"], 30)

    def test_schema_errors_are_not_empty_data_even_with_http_400(self):
        self.response.json.return_value = {"errors": [{"message": "Pagination.index is required"}]}
        self.response.raise_for_status.side_effect = OSError("HTTP 400")
        with self.assertRaisesRegex(Exception, "Pagination.index"):
            self.api.search_entities("BRCA1")

    def test_current_drug_and_candidate_rows_are_returned_without_invented_phases(self):
        candidates = {"count": 1, "rows": [{"id": "fixture", "maxClinicalStage": "Clinical", "drug": None}]}
        self.response_data({"disease": {"drugAndClinicalCandidates": candidates}})
        self.assertEqual(self.api.get_known_drugs_for_disease("fixture"), candidates)
        drug = {"id": "fixture", "maximumClinicalStage": "Clinical", "synonyms": [{"label": "label", "source": "fixture"}], "indications": {"count": 0, "rows": []}}
        self.response_data({"drug": drug})
        self.assertEqual(self.api.get_drug_info("fixture"), drug)

    def test_score_filter_retains_requested_rows(self):
        rows = [{"score": 0.2}, {"score": 0.7}, {"score": 0.9}]
        self.response_data({"target": {"associatedDiseases": {"rows": rows}}})
        self.assertEqual(self.api.get_target_associations("fixture", 0.5), rows[1:])


class Zotero(unittest.TestCase):
    def setUp(self):
        self.module = load("test_zotero", "writing/zotero-local/scripts/zotero_local.py")
        self.requests = []
        self.routes = {"/api/itemTypes": (200, [{"itemType": "journalArticle"}], {})}
        self.trickle = None
        self.trickle_writes = 0
        self.stop_event = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.requests.append((self.path, dict(self.headers)))
                if owner.trickle:
                    prefix = (b"HTTP/1.1 200 OK\r\nX-Slow: " if owner.trickle == "headers" else
                              b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n")
                    try:
                        self.wfile.write(prefix)
                        while not owner.stop_event.wait(0.02):
                            self.wfile.write(b" ")
                            owner.trickle_writes += 1
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    return
                status, data, headers = owner.routes.get(urlparse(self.path).path, (404, {}, {}))
                self.send_response(status)
                self.send_header("Zotero-API-Version", "3")
                for name, value in headers.items():
                    self.send_header(name, value)
                self.end_headers()
                body = data if isinstance(data, bytes) else json.dumps(data).encode()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        self.thread.start()
        self.client = self.module.ZoteroLocal(self.server.server_port)
        self.addCleanup(self.stop)

    def stop(self):
        self.stop_event.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)

    def test_doctor_reads_metadata_not_library_and_bypasses_environment_proxy(self):
        with patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1", "no_proxy": "", "NO_PROXY": ""}):
            client = self.module.ZoteroLocal(self.server.server_port)
            self.assertTrue(client.doctor()["connected"])
        self.assertEqual([row[0] for row in self.requests], ["/api/itemTypes"])
        self.assertEqual(self.requests[0][1]["Zotero-API-Version"], "3")

    def test_search_escapes_queries_and_keeps_pagination_explicit(self):
        rows = [{"key": "ABCD1234", "data": {"title": "Synthetic reference"}}]
        self.routes["/api/users/0/items/top"] = (200, rows, {})
        self.assertEqual(self.client.read("search", "a & b / ?", limit=5, start=10), rows)
        params = parse_qs(urlparse(self.requests[-1][0]).query)
        self.assertEqual(params, {"format": ["json"], "limit": ["5"], "start": ["10"], "q": ["a & b / ?"], "qmode": ["titleCreatorYear"]})

    def test_selected_item_and_collection_use_only_fixed_read_routes(self):
        item = {"key": "ABCD1234", "data": {"title": "Fixture"}}
        self.routes["/api/users/0/items/ABCD1234"] = (200, item, {})
        self.routes["/api/users/0/collections/ABCD1234/items/top"] = (200, [item], {})
        self.routes["/api/users/0/collections"] = (200, [{"key": "ABCD1234"}], {})
        self.assertEqual(self.client.read("item", "ABCD1234"), item)
        self.assertEqual(self.client.read("items", collection="ABCD1234"), [item])
        self.assertEqual(self.client.read("collections"), [{"key": "ABCD1234"}])

    def test_redirect_is_not_followed(self):
        self.routes["/api/itemTypes"] = (302, {}, {"Location": f"http://127.0.0.1:{self.server.server_port}/external"})
        with self.assertRaisesRegex(RuntimeError, "redirect"):
            self.client.doctor()
        self.assertEqual(len(self.requests), 1)

    def test_denied_malformed_and_oversized_responses_fail_explicitly(self):
        for response, message in [((403, {}, {}), "access denied"), ((200, b"not JSON", {}), "valid JSON"), ((200, b"x" * (self.module.MAX_BYTES + 1), {}), "too large")]:
            with self.subTest(message=message):
                self.routes["/api/itemTypes"] = response
                with self.assertRaisesRegex(RuntimeError, message):
                    self.client.doctor()

    def test_invalid_keys_limits_and_commands_stop_before_request(self):
        for command, kwargs in [("item", {"value": "../other"}), ("items", {"collection": "http://example.org"}), ("items", {"limit": 101}), ("items", {"start": -1}), ("search", {"value": " "}), ("delete", {})]:
            with self.subTest(command=command, kwargs=kwargs), self.assertRaises(ValueError):
                self.client.read(command, **kwargs)
        self.assertEqual(self.requests, [])

    def test_transport_timeout_is_bounded_and_not_retried(self):
        with patch.object(self.module.socket, "create_connection", side_effect=TimeoutError) as request:
            with self.assertRaisesRegex(RuntimeError, "10 seconds"):
                self.client.doctor()
        self.assertEqual(request.call_count, 1)
        self.assertEqual(request.call_args.args, (("127.0.0.1", self.server.server_port),))
        self.assertEqual(request.call_args.kwargs["timeout"], 10)

    def assert_trickle_deadline(self, phase):
        self.trickle = phase
        began = time.monotonic()
        with patch.object(self.module, "TIMEOUT", 0.15):
            with self.assertRaisesRegex(RuntimeError, "timed out.*no retry"):
                self.client.doctor()
        self.assertLess(time.monotonic() - began, 1.5)
        self.assertGreaterEqual(self.trickle_writes, 2)
        self.assertEqual(len(self.requests), 1)

    def test_header_trickle_cannot_extend_total_deadline(self):
        self.assert_trickle_deadline("headers")

    def test_body_trickle_cannot_extend_total_deadline(self):
        self.assert_trickle_deadline("body")


if __name__ == "__main__":
    unittest.main()
