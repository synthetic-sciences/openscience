#!/usr/bin/env python3
"""Behavioral tests for bundled dataset helpers; no Hub requests."""

import json
import os
import sys

import pytest

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "scripts"),
)

import dataset_manager  # noqa: E402


TEMPLATES_DIR = dataset_manager.EXAMPLES_DIR.parent / "templates"


def bundled_template_types():
    """The `type` declared by every template shipped with the skill."""
    return {
        path.stem: json.loads(path.read_text(encoding="utf-8")).get("type")
        for path in sorted(TEMPLATES_DIR.glob("*.json"))
    }


@pytest.mark.parametrize("name", sorted(bundled_template_types()))
def test_bundled_examples_validate(name):
    template = dataset_manager.load_dataset_template(name)
    assert dataset_manager.validate_training_data(template.get("examples", []), name)


# (rows, should_be_accepted, description)
QA_CASES = [
    ([{"question": "What is 2+2?", "answer": "four"}], True, "string answer"),
    ([{"question": "Names?", "answer": ["red", "blue"]}], True, "list answer"),
    ([{"question": "q", "answer": 42}], False, "answer is a number"),
    ([{"question": "q", "answer": []}], False, "answer is an empty list"),
    ([{"question": "q", "answer": [""]}], False, "answer list holds a blank"),
    ([{"question": "q", "answer": ""}], False, "answer is empty"),
    ([{"question": "   ", "answer": "a"}], False, "question is blank"),
    ([{"question": 7, "answer": "a"}], False, "question is not a string"),
    ([{"question": "q"}], False, "answer missing"),
]

COMPLETION_CASES = [
    ([{"prompt": "Name a color", "completion": "blue"}], True, "well formed"),
    ([{"prompt": "", "completion": "blue"}], False, "prompt is empty"),
    ([{"prompt": "p", "completion": ""}], False, "completion is empty"),
    ([{"prompt": "p", "completion": ["blue"]}], False, "completion is a list"),
    ([{"prompt": "p"}], False, "completion missing"),
]


@pytest.mark.parametrize("rows,accepted,description", QA_CASES, ids=[d for _, _, d in QA_CASES])
def test_qa_rows_are_structurally_validated(rows, accepted, description):
    assert dataset_manager.validate_training_data(rows, "qa") is accepted, description


@pytest.mark.parametrize(
    "rows,accepted,description",
    COMPLETION_CASES,
    ids=[d for _, _, d in COMPLETION_CASES],
)
def test_completion_rows_are_structurally_validated(rows, accepted, description):
    assert dataset_manager.validate_training_data(rows, "completion") is accepted, description


def test_custom_still_accepts_a_caller_defined_shape():
    """`custom` is the escape hatch: no structure is imposed on it."""
    rows = [{"data": {"anything": [1, 2, 3]}, "schema": {"a": "int"}}]
    assert dataset_manager.validate_training_data(rows, "custom") is True


def test_custom_still_requires_its_declared_field():
    """The generic required-field pass still applies to custom."""
    assert dataset_manager.validate_training_data([{"not_data": 1}], "custom") is False


def test_an_unknown_template_type_says_so_instead_of_claiming_validation(capsys):
    """An unrecognised type must not report a validation that never happened."""
    template = {"type": "mystery", "validation_schema": {"required_fields": []}}
    assert dataset_manager.validate_by_template([{"a": 1}], template) is True
    assert "No structural validator" in capsys.readouterr().out


def test_a_template_without_a_type_does_not_raise(capsys):
    """Dispatch reads the type defensively; a missing one is not a crash."""
    template = {"validation_schema": {"required_fields": []}}
    assert dataset_manager.validate_by_template([{"a": 1}], template) is True
    assert "No structural validator" in capsys.readouterr().out


@pytest.mark.parametrize(
    "template,rows",
    [
        ("chat", [{"messages": [{"role": "user", "content": "hi"}]}]),
        ("classification", [{"text": "t", "label": "l"}]),
        ("tabular", [{"data": [1], "columns": ["a"]}]),
    ],
)
def test_the_original_validators_still_apply(template, rows):
    """The pre-existing validators keep their behaviour."""
    assert dataset_manager.validate_training_data(rows, template) is True
    assert dataset_manager.validate_training_data([{"nope": 1}], template) is False

@pytest.mark.parametrize("row", [None, 1, "text", ["text"]])
def test_non_object_rows_are_rejected(row):
    assert dataset_manager.validate_training_data([row], "chat") is False


@pytest.mark.parametrize("label,accepted", [(3, False), ({"x": 1}, False), ("positive", True), (["positive"], True)])
def test_classification_union_type(label, accepted):
    assert dataset_manager.validate_training_data([{"text": "sample", "label": label}], "classification") is accepted
