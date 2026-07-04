# Paper Mechanics Checklist

Comprehensive checklist for presentation details that human reviewers frequently identify. These mechanical issues are often missed by content-focused review but significantly impact paper quality.

## Table Audit

### Numeric Content

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Qualitative descriptors | "Higher", "Better", "↑" | Actual numbers: "15.3%", "+2.4" |
| Missing values | Empty cells, "N/A" without explanation | Complete data or explain missingness |
| Inconsistent precision | "15.3" vs "15" vs "15.300" | Consistent significant figures |
| Missing units | "Speed: 15" | "Speed (ms): 15" |

### Structure and Headers

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Ambiguous abbreviations | "Acc." without definition | Define in caption or use full words |
| Inconsistent naming | "BERT" in Table 1, "bert" in Table 2 | Consistent capitalization |
| Missing baselines | Only proposed method shown | Include relevant baselines |
| Unclear groupings | Methods and datasets mixed | Logical organization with separators |

### Caption Completeness

| Requirement | Example |
|-------------|---------|
| Self-explanatory | Reader understands without text reference |
| Abbreviation definitions | "ACC: accuracy, F1: F1-score" |
| Data source | "Results on MNLI dev set" |
| Statistical info | "Mean ± std over 5 runs" |

### Common Table Issues Checklist

- [ ] All cells contain numeric values (not just "Higher/Lower")
- [ ] Column headers are clear and complete
- [ ] Units are specified for all measurements
- [ ] Significant figures are appropriate and consistent
- [ ] Best values are clearly indicated (bold, underline)
- [ ] Statistical uncertainty reported (std, CI, p-values)
- [ ] Baselines and comparisons are included
- [ ] Caption is self-explanatory

## Figure Audit

### Legibility

| Issue | Indicator | Standard |
|-------|-----------|----------|
| Text too small | Unreadable at 100% zoom | Minimum 8pt in final figure |
| Axis labels missing | No indication of what's plotted | All axes labeled with units |
| Legend obscures data | Legend overlaps plot area | Legend in clear space or outside |
| Low resolution | Pixelation visible | 300+ DPI for print |

### Color and Accessibility

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Red-green scheme | Default matplotlib colors | Colorblind-safe palettes |
| Too many colors | 10+ colors in one plot | Limit to 6-7, use shapes/patterns |
| Low contrast | Light colors on white | Sufficient contrast for visibility |
| Inconsistent colors | Same method, different colors across figures | Consistent color scheme |

### Plot Quality

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Missing error bars | Point estimates only | Show uncertainty (std, CI) |
| Truncated axes | Y-axis starting at 90 for 91-95 range | Start at 0 or clearly indicate break |
| Cluttered | Too many lines/points | Simplify or split into panels |
| Cherry-picked range | Hiding poor performance region | Show full range |

### Common Figure Issues Checklist

- [ ] Text readable at 100% zoom (minimum 8pt final size)
- [ ] All axes labeled with units
- [ ] Legend doesn't obscure data
- [ ] Colors are colorblind-accessible
- [ ] Error bars or uncertainty shown
- [ ] Consistent color scheme across paper
- [ ] Resolution suitable for print (300+ DPI)
- [ ] Aspect ratio appropriate for content

## Notation Audit

### Variable Definitions

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Undefined variables | "We minimize L" (L never defined) | Define before first use |
| Delayed definitions | Used on page 3, defined on page 5 | Define at first occurrence |
| Implicit assumptions | "The standard loss" without specification | Explicitly state the loss function |

### Consistency

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Symbol reuse | θ for parameters and temperature | Different symbols for different concepts |
| Inconsistent notation | x, X, **x** for same concept | Pick one style and maintain |
| Mixed conventions | 0-indexed and 1-indexed in same paper | Consistent indexing convention |

### Standard Conventions

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Non-standard notation | Unusual symbols for common concepts | Use field-standard notation |
| Missing font conventions | Scalars and vectors same font | Scalars: italic, vectors: bold |
| Equation numbering | Important equations unnumbered | Number equations that are referenced |

### Notation Checklist

- [ ] All variables defined before first use
- [ ] No symbol reuse for different concepts
- [ ] Consistent notation throughout paper
- [ ] Font conventions followed (italic scalars, bold vectors)
- [ ] Standard field notation used where applicable
- [ ] Important equations are numbered

## Structure Audit

### Section Redundancy

| Issue | Indicator | Fix |
|-------|-----------|-----|
| Repeated content | Same information in Intro and Related Work | Consolidate or differentiate purpose |
| Restated results | Discussion repeats Results verbatim | Discussion should interpret, not repeat |
| Redundant background | Method section re-explains preliminaries | Reference earlier sections |

### Cross-References

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Orphan figures | Figure 3 never mentioned in text | Reference all figures in text |
| Missing references | "As shown above" without citation | Specific section/figure references |
| Broken references | "See Section ??" | Verify all cross-references |

### Citation Completeness

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Unsupported claims | "It is well known that..." | Add citation |
| Missing seminal work | No citation for foundational methods | Cite original sources |
| Only self-citations | All citations are author's prior work | Balanced citation of field |
| Outdated citations | Most recent citation from 5+ years ago | Include recent relevant work |

### Structure Checklist

- [ ] No redundant content across sections
- [ ] All figures and tables referenced in text
- [ ] Cross-references are complete and correct
- [ ] All factual claims are cited
- [ ] Citation coverage includes recent work
- [ ] Self-citations are proportionate

## Abstract and Title Audit

### Title Quality

| Issue | Example (Fail) | Fix |
|-------|---------------|-----|
| Too vague | "A New Method for NLP" | Specific: "Efficient Attention for Long Documents" |
| Too long | 20+ words | Target 10-15 words |
| Clickbait | "Groundbreaking breakthrough in..." | Factual and professional |
| Acronym-heavy | "BERT-GAN for NER via RL" | Expand key terms |

### Abstract Completeness

| Required Element | Check |
|-----------------|-------|
| Problem statement | What gap does this address? |
| Method summary | What approach is taken? |
| Key results | What are the main findings? |
| Significance | Why does this matter? |

### Abstract Issues Checklist

- [ ] Problem clearly stated
- [ ] Method briefly described
- [ ] Key results with numbers (not just "improves")
- [ ] Claims match actual results in paper
- [ ] Within word limit for venue
- [ ] Self-contained (no citations needed)

## Methods Reproducibility Audit

### Technical Details

| Required Element | Check |
|-----------------|-------|
| Hyperparameters | Learning rate, batch size, etc. |
| Random seeds | For reproducibility |
| Compute resources | GPU type, training time |
| Software versions | PyTorch version, etc. |

### Data Details

| Required Element | Check |
|-----------------|-------|
| Dataset sources | Where to obtain |
| Preprocessing | Exact steps applied |
| Splits | Train/val/test sizes |
| Licenses | Usage rights |

### Reproducibility Checklist

- [ ] All hyperparameters specified
- [ ] Random seeds reported
- [ ] Compute requirements stated
- [ ] Software versions listed
- [ ] Data sources provided
- [ ] Preprocessing steps documented
- [ ] Code availability statement present

## Quick Scan Protocol

For efficient paper mechanics review:

### 30-Second Table Scan
1. Check any table for "Higher"/"Better" instead of numbers
2. Verify units are present
3. Check for missing cells

### 30-Second Figure Scan
1. Zoom to 100% and check text readability
2. Look for legend/data overlap
3. Check for error bars

### 30-Second Notation Scan
1. Find first equation and check if variables defined
2. Look for repeated symbols
3. Check for undefined acronyms

### 30-Second Structure Scan
1. Compare Intro and Related Work for redundancy
2. Check if all figures referenced in text
3. Look for unsupported factual claims

## Reporting Format

When reporting mechanics issues:

```markdown
### Paper Mechanics Issues

**Tables:**
- [Moderate] Table 1: Uses "Higher" instead of numeric values for improvement column
- [Minor] Table 2: Missing units for latency column

**Figures:**
- [Major] Figure 3: Axis labels unreadable at 100% zoom
- [Minor] Figure 5: Legend overlaps with data points

**Notation:**
- [Moderate] Variable θ used for both model parameters (p.3) and temperature (p.7)

**Structure:**
- [Minor] Section 2.1 and 3.2 contain redundant background on transformers
```

## Severity Guide for Mechanics

| Severity | Criteria | Examples |
|----------|----------|----------|
| **Major** | Impedes understanding or evaluation | Illegible figures, undefined key notation |
| **Moderate** | Reduces quality but comprehensible | Non-numeric table values, minor redundancy |
| **Minor** | Polish issue, easy to fix | Small legend overlap, missing units |

Mechanics issues are typically Minor or Moderate, rarely Major, and never Critical (unless they hide scientific issues).
