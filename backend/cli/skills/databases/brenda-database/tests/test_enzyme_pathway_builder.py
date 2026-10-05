#!/usr/bin/env python3
"""
Tests for enzyme_pathway_builder's transformation inference.

infer_transformation_type classifies metabolites through identify_metabolite,
which lowercases its input, then probes the raw substrate and product strings for
the transformation keywords. These tests pin that a metabolite's spelling - lower
case, upper case, title case - reaches the same classification.

No network, no BRENDA SOAP calls, no zeep: everything here is the pure
inference layer.
"""

import os
import sys

import pytest

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "scripts"),
)

import enzyme_pathway_builder as epb  # noqa: E402


# (substrate, product, the transformation that must be found)
CLASSIFIED_PAIRS = [
    ("glucose", "glucose-6-phosphate", "phosphorylation"),
    ("glucose-6-phosphate", "glucose", "dephosphorylation"),
    ("pyruvate", "co2", "carboxylation"),
]


def spellings(name):
    return [name, name.upper(), name.title()]


@pytest.mark.parametrize("substrate,product,expected", CLASSIFIED_PAIRS)
def test_a_classified_transformation_does_not_depend_on_spelling(substrate, product, expected):
    """Upper-case metabolite names used to fall through to 'generic'."""
    for substrate_form in spellings(substrate):
        for product_form in spellings(product):
            inferred = epb.infer_transformation_type(substrate_form, product_form)
            assert expected in inferred, (
                f"{substrate_form!r} -> {product_form!r} inferred {inferred}, "
                f"expected {expected!r}"
            )


@pytest.mark.parametrize("substrate,product", [(s, p) for s, p, _ in CLASSIFIED_PAIRS])
def test_inference_is_identical_across_spellings(substrate, product):
    """The invariant itself: no spelling may classify differently from another."""
    baseline = epb.infer_transformation_type(substrate, product)
    for substrate_form in spellings(substrate):
        for product_form in spellings(product):
            assert epb.infer_transformation_type(substrate_form, product_form) == baseline


def test_an_unknown_pair_still_falls_back_to_generic():
    """The fallback is unchanged: no keyword matched."""
    assert epb.infer_transformation_type("unobtainium", "unobtainium-2") == ["generic"]


def test_a_generic_result_is_not_offered_as_a_transformation():
    """'generic' is a fallback label, not a transformation with EC prefixes, so a
    case that still infers 'generic' yields no enzyme suggestions at all."""
    assert "generic" not in epb.COMMON_TRANSFORMATIONS


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))


def test_fallback_queries_reach_both_pathway_builders(monkeypatch):
    import brenda_client

    def query(method, **filters):
        if method == "getReaction" and filters.get("reaction") in ("*phosphorylation*", "*oxidation*"):
            return ["ecNumber*2.7.1.1#organism*Fixture#reaction*precursor = product"]
        return []

    monkeypatch.setattr(brenda_client, "_query", query)
    monkeypatch.setattr(epb.time, "sleep", lambda _: None)
    enzymes = epb.find_enzymes_for_transformation("glucose", "glucose-6-phosphate")
    assert enzymes and enzymes[0]["ec_number"] == "2.7.1.1"
    assert enzymes[0]["confidence"] == "low"
    tree = epb.build_retrosynthetic_tree("unobtainium", depth=2)
    assert "precursor_oxidation_unobtainium" in tree["nodes"]
    assert tree["total_edges"] > 0
