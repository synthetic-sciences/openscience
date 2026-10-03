#!/usr/bin/env python3
"""
Tests for dataset_manager's per-template structural validation.

`validate_by_template` dispatched type-specific validators for chat,
classification and tabular only, through a bare if/elif with no else. The CLI
advertises six templates for both `add_rows` and `quick_setup`, so qa,
completion and custom rows were checked for required field presence and nothing
more -- while the success line still reported them as validated:

    Row 0: Recommended to include: {'context'}
    ✓ Validated 1 examples for qa dataset

The generic field_types pass could not cover the gap either: it matches the
declared type against a fixed set of names, so a union such as `string|array`
compares equal to none of them and is silently ignored.

These tests pin that every shipped template either has a structural validator
or is `custom`, and that the qa and completion validators reject rows that do
not fit their shape.

Pure local logic: templates are read from the skill directory and no Hub call
is made.
"""

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


@pytest.mark.parametrize("name,template_type", sorted(bundled_template_types().items()))
def test_every_shipped_template_has_a_structural_validator(name, template_type):
    """A template advertised by --template must not fall through unvalidated."""
    assert template_type in dataset_manager._TEMPLATE_VALIDATORS or template_type == "custom", (
        f"template '{name}' declares type '{template_type}' but no structural "
        "validator is registered for it"
    )


@pytest.mark.parametrize("name,template_type", sorted(bundled_template_types().items()))
def test_every_shipped_template_loads(name, template_type):
    """The templates the dispatch table points at are the ones on disk."""
    assert dataset_manager.load_dataset_template(name).get("type") == template_type


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