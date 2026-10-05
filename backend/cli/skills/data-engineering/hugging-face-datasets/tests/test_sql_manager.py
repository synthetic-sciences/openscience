#!/usr/bin/env python3
"""Behavioral tests for bundled dataset helpers; no Hub requests."""

import os
import sys

import pytest

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "scripts"),
)

import sql_manager  # noqa: E402


HF_PATH = "hf://datasets/cais/mmlu@~parquet/default/train/*.parquet"


class _RecordingResult:
    """Minimal stand-in for a DuckDB result."""

    description = [("count", "NUMBER")]

    def fetchall(self):
        return [(1,)]

    def fetchdf(self):
        return [(1,)]

    def fetch_arrow_table(self):
        return [(1,)]


class _RecordingConnection:
    """Stands in for the DuckDB connection and records the SQL it receives."""

    def __init__(self):
        self.statements = []

    def execute(self, statement, *args, **kwargs):
        self.statements.append(statement)
        return _RecordingResult()

    def close(self):
        pass


def _recording_manager():
    manager = sql_manager.HFDatasetSQL()
    recorder = _RecordingConnection()
    manager.conn.close()
    manager.conn = recorder
    return manager, recorder


# (query, description)
SUBSTITUTED = [
    ("SELECT * FROM data", "documented lower case"),
    ("select * from data", "lower-case keyword"),
    ("Select count(*) From Data", "title-case keyword and table"),
    ("SELECT COUNT(*) FROM DATA", "upper-case keyword and table"),
    ("SELECT subject FROM Data LIMIT 1", "mixed-case table"),
    ("SELECT a FROM data JOIN data USING (id)", "two placeholders"),
    ("SELECT a FROM DATA JOIN Data USING (id)", "upper-case join"),
    ("select a from data\njoin data using (id)", "newline separated"),
    ("SELECT a FROM  data   LIMIT 1", "extra whitespace"),
]

NOT_SUBSTITUTED = [
    ("SELECT * FROM metadata LIMIT 1", "identifier that starts with data"),
    ("SELECT * FROM data_2 LIMIT 1", "identifier that extends data"),
    ("SELECT * FROM database LIMIT 1", "identifier that contains data"),
    ("SELECT * FROM schema.data LIMIT 1", "qualified table name"),
    ("SELECT data FROM t LIMIT 1", "data as a column, not a table"),
    ("SELECT * FROM other LIMIT 1", "no placeholder at all"),
]


@pytest.mark.parametrize("query,description", SUBSTITUTED, ids=[d for _, d in SUBSTITUTED])
def test_placeholder_resolves_in_any_letter_case(query, description):
    """Case variants used to survive into DuckDB and raise CatalogException."""
    assert f"'{HF_PATH}'" in sql_manager._substitute_data_placeholder(query, HF_PATH), description


@pytest.mark.parametrize("query,description", NOT_SUBSTITUTED, ids=[d for _, d in NOT_SUBSTITUTED])
def test_neighbouring_identifiers_are_left_alone(query, description):
    """The rewrite must not reach past the word `data`."""
    assert sql_manager._substitute_data_placeholder(query, HF_PATH) == query, description


def test_keyword_and_spacing_are_preserved():
    """The caller's keyword casing and spacing survive the rewrite."""
    rewritten = sql_manager._substitute_data_placeholder("select  a\nFrom\tData", HF_PATH)
    assert rewritten == f"select  a\nFrom\t'{HF_PATH}'"


@pytest.mark.parametrize("query,description", SUBSTITUTED, ids=[d for _, d in SUBSTITUTED])
def test_query_hands_duckdb_a_resolved_path(query, description):
    """query() must not leave a bare table reference for DuckDB to resolve."""
    manager, recorder = _recording_manager()
    manager.query("cais/mmlu", query)
    assert f"'{HF_PATH}'" in recorder.statements[-1], description


def test_export_to_parquet_resolves_the_placeholder_too():
    """export_to_parquet duplicated the old replace chain; it now shares the helper."""
    manager, recorder = _recording_manager()
    manager.export_to_parquet("cais/mmlu", "out.parquet", sql="SELECT * FROM Data")
    statement = recorder.statements[-1]
    assert f"SELECT * FROM '{HF_PATH}'" in statement
    # The COPY wrapper must receive syntactically valid SQL.
    assert f"'{HF_PATH}'_2" not in statement


# (query, description) -- an hf:// reference that has nothing to do with the
# placeholder must not suppress substitution.
UNRELATED_HF_REFERENCE = [
    ("SELECT * FROM data WHERE source = 'hf://datasets/other/x'", "hf path in a literal"),
    ("SELECT * FROM data WHERE url LIKE 'hf://%'", "hf prefix in a LIKE pattern"),
    ("SELECT * FROM data WHERE doc = 'see hf://docs'", "prose mentioning hf"),
    ("SELECT * FROM 'hf://datasets/other/x' JOIN data USING (id)", "raw path joined to placeholder"),
]


@pytest.mark.parametrize(
    "query,description",
    UNRELATED_HF_REFERENCE,
    ids=[d for _, d in UNRELATED_HF_REFERENCE],
)
def test_unrelated_hf_reference_does_not_discard_substitution(query, description):
    """An hf:// substring anywhere used to throw the resolved path away."""
    manager, recorder = _recording_manager()
    manager.query("cais/mmlu", query)
    assert f"'{HF_PATH}'" in recorder.statements[-1], description


def test_fully_qualified_path_is_still_passed_through_unchanged():
    """A query that already names a raw path has nothing to substitute."""
    raw = "SELECT * FROM 'hf://datasets/other/x' LIMIT 1"
    manager, recorder = _recording_manager()
    manager.query("cais/mmlu", raw)
    assert recorder.statements[-1] == raw


def test_query_raw_is_unaffected():
    """query_raw() never substituted, and must keep not substituting."""
    manager, recorder = _recording_manager()
    manager.query_raw("SELECT * FROM data")
    assert recorder.statements[-1] == "SELECT * FROM data"


@pytest.mark.parametrize("sql", [
    "SELECT 'From Data' AS label FROM other",
    'SELECT * FROM "data"',
    "SELECT * FROM data.schema",
    "SELECT * FROM data$archive",
    "SELECT * FROM data()",
    "SELECT $$From Data$$ AS label",
    "SELECT 1 /* FROM data /* nested */ */",
    "SELECT 1 -- JOIN DATA",
])
def test_preserves_literals_comments_and_other_identifiers(sql):
    assert sql_manager._substitute_data_placeholder(sql, HF_PATH) == sql


def test_real_duckdb_query_preserves_unicode_literals_and_quoted_paths(tmp_path):
    manager = sql_manager.HFDatasetSQL()
    source = tmp_path / "data'file.parquet"
    escaped = str(source).replace("'", "''")
    manager.conn.execute(f"COPY (SELECT 42 AS value) TO '{escaped}' (FORMAT PARQUET)")
    sql = "SELECT 'é From Data' AS label, value From /* comment */ Data"
    processed = sql_manager._substitute_data_placeholder(sql, str(source))
    assert manager.conn.execute(processed).fetchall() == [("é From Data", 42)]
    manager.close()
