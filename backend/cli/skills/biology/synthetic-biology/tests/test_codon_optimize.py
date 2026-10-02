#!/usr/bin/env python3
"""
Tests for the GC constraint in codon_optimize.

Pins the invariant fix_gc_content exists for: a 30 bp window outside the 40-60%
band gets corrected even when the whole-sequence GC already looks acceptable.
Pure Python -- no biopython, no external tools.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))

import codon_optimize as co

WINDOW = 30
TARGET_MIN = 0.40
TARGET_MAX = 0.60

# 10x Val (GTC, 2 of 3 bases GC) then 6x Phe (TTT, no GC): the whole sequence lands
# at 41.7% -- inside the band -- while the leading window sits at 66.7%.
HIGH_WINDOW = ("GTC" * 10) + ("TTT" * 6)

# Every 30 bp window already inside the band.
IN_RANGE = "GCACCCTTGGTGTATCTCTTCTCCATTTCCGCC"


def window_gcs(dna, window=WINDOW):
    return [co.gc_content(dna[i:i + window]) for i in range(0, max(0, len(dna) - window + 1), 3)]


def correct(dna, organism="ecoli"):
    return "".join(co.fix_gc_content(list(co.get_codons(dna)), organism))


def out_of_range(gcs):
    return [g for g in gcs if not TARGET_MIN <= g <= TARGET_MAX]


class TestFixGcContent:
    def test_corrects_a_high_window_even_when_the_whole_sequence_is_in_range(self):
        assert TARGET_MIN <= co.gc_content(HIGH_WINDOW) <= TARGET_MAX
        assert out_of_range(window_gcs(HIGH_WINDOW))

        fixed = correct(HIGH_WINDOW)

        assert fixed != HIGH_WINDOW, "fix_gc_content returned the input unchanged"
        assert not out_of_range(window_gcs(fixed))

    def test_leaves_a_sequence_whose_windows_are_all_in_range_byte_identical(self):
        assert not out_of_range(window_gcs(IN_RANGE))

        assert correct(IN_RANGE) == IN_RANGE

    def test_preserves_translation(self):
        for dna in (HIGH_WINDOW, IN_RANGE):
            assert co.translate_dna(correct(dna)) == co.translate_dna(dna)

    def test_is_deterministic(self):
        assert correct(HIGH_WINDOW) == correct(HIGH_WINDOW)

    def test_sequence_shorter_than_one_window_is_left_alone(self):
        short = "ATGAAAGCG"

        assert correct(short) == short

    def test_uses_the_requested_gc_band_for_custom_targets(self):
        for dna, lower, upper in [("GTC" * 10, 0.30, 0.40), ("GCT" * 10, 0.70, 0.80)]:
            fixed = "".join(co.fix_gc_content(list(co.get_codons(dna)), "ecoli", lower, upper))
            assert lower <= co.gc_content(fixed) <= upper
            assert co.translate_dna(fixed) == co.translate_dna(dna)


class TestOptimizeSequence:
    def test_removes_out_of_range_windows_from_a_back_translated_protein(self):
        protein = "IPPSDGRPVKFQVKQN"
        dna = co.back_translate(protein, "ecoli")
        assert out_of_range(window_gcs(dna))

        optimized = co.optimize_sequence(dna, "ecoli")

        assert not out_of_range(window_gcs(optimized))
        assert co.translate_dna(optimized) == co.translate_dna(dna)


if __name__ == "__main__":
    sys.exit(__import__("pytest").main([__file__, "-v"]))
