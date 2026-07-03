# Scoring Rubrics Reference

## Overview

A good rubric is the difference between noisy and reliable LLM-as-judge evaluation.
This reference provides rubric templates for common evaluation scenarios.

## Rubric Design Principles

1. **Specific anchors**: Each score level must describe observable behavior, not vague quality
2. **Independent dimensions**: Criteria should not overlap (avoid "quality" and "helpfulness")
3. **Weighted dimensions**: Not all criteria matter equally — assign weights
4. **Calibration examples**: Include 2-3 example responses with their expected scores
5. **Task-aligned**: The rubric should match what your users actually care about

## Template: General Quality

```
Dimensions (all weighted equally unless specified):

1. Accuracy
   1: Contains factual errors or hallucinations
   2: Mostly correct but with notable inaccuracies
   3: Factually correct on main points, minor issues
   4: Accurate and well-supported claims
   5: Perfectly accurate with appropriate caveats

2. Relevance
   1: Does not address the user's question
   2: Partially relevant, misses key aspects
   3: Addresses the main question adequately
   4: Comprehensive coverage of the topic
   5: Precisely addresses every aspect of the question

3. Clarity
   1: Confusing, poorly organized
   2: Understandable but hard to follow
   3: Clear and logically organized
   4: Well-structured with good flow
   5: Exceptionally clear, easy to scan and understand

4. Conciseness
   1: Extremely verbose, buries the answer
   2: Contains significant unnecessary content
   3: Appropriate length for the question
   4: Efficiently communicated
   5: Optimal length — every word serves a purpose
```

## Template: Code Generation

```
Dimensions:

1. Correctness (weight: 0.40)
   1: Won't compile/run, fundamental logic errors
   2: Runs but fails on basic test cases
   3: Handles common cases correctly
   4: Handles edge cases, good error handling
   5: Correct, robust, handles all specified requirements

2. Code Quality (weight: 0.25)
   1: Unreadable, no structure
   2: Poor naming, minimal structure
   3: Acceptable style, reasonable naming
   4: Clean, well-organized, follows conventions
   5: Exemplary code that teaches best practices

3. Efficiency (weight: 0.15)
   1: Exponential complexity or worse
   2: Unnecessarily slow (wrong algorithm choice)
   3: Acceptable for typical input sizes
   4: Well-optimized, appropriate algorithms
   5: Optimal or near-optimal solution

4. Completeness (weight: 0.20)
   1: Missing major requirements
   2: Partial implementation, key gaps
   3: Core requirements met
   4: Complete with error handling
   5: Complete with tests, docs, and error handling
```

## Template: Customer Support

```
Dimensions:

1. Problem Resolution (weight: 0.40)
   1: Does not address the customer's issue
   2: Acknowledges issue but provides wrong solution
   3: Provides a valid solution that may not be optimal
   4: Provides the best available solution
   5: Resolves issue and proactively prevents related problems

2. Tone & Empathy (weight: 0.25)
   1: Rude, dismissive, or robotic
   2: Professional but cold
   3: Friendly and professional
   4: Warm, empathetic, personalized
   5: Exceptional rapport while maintaining professionalism

3. Accuracy (weight: 0.20)
   1: Contains incorrect information about products/policies
   2: Mostly correct with some errors
   3: Factually accurate
   4: Accurate with helpful additional context
   5: Perfectly accurate with relevant links/resources

4. Efficiency (weight: 0.15)
   1: Requires multiple follow-ups for basic resolution
   2: Could be more direct
   3: Reasonable number of steps to resolution
   4: Efficient resolution path
   5: Resolves in minimum possible interactions
```

## Template: Summarization

```
Dimensions:

1. Faithfulness (weight: 0.35)
   1: Contains hallucinated information not in source
   2: Mostly faithful but adds unsupported claims
   3: Faithful to source material
   4: Accurately represents source with proper nuance
   5: Perfectly faithful, captures nuance and caveats

2. Coverage (weight: 0.30)
   1: Misses most key points
   2: Captures some key points, misses important ones
   3: Covers main points adequately
   4: Comprehensive coverage of key information
   5: Captures all important points and relationships

3. Coherence (weight: 0.20)
   1: Disjointed, hard to follow
   2: Some logical flow issues
   3: Reads smoothly
   4: Well-organized with clear structure
   5: Exemplary narrative flow

4. Conciseness (weight: 0.15)
   1: As long as original (no compression)
   2: Minimal compression, includes unnecessary details
   3: Reasonable length reduction
   4: Well-compressed, only essential information
   5: Maximum information density, every word counts
```

## Composite Scoring

```python
def weighted_score(scores, weights):
    """Calculate weighted composite score from dimension scores.

    Args:
        scores: dict of {"dimension": score} (1-5)
        weights: dict of {"dimension": weight} (sums to 1.0)
    """
    total = sum(scores[dim] * weights[dim] for dim in scores)
    return round(total, 2)

# Example
scores = {"correctness": 4, "quality": 3, "efficiency": 5, "completeness": 4}
weights = {"correctness": 0.4, "quality": 0.25, "efficiency": 0.15, "completeness": 0.2}
composite = weighted_score(scores, weights)  # 3.85
```
