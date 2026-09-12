# BIDS Core Workflows

The twelve workflow areas in full, with worked code and commands: directory structure,
`dataset_description.json`, querying with PyBIDS, validation (PyPI wrapper, Deno, legacy
Node, and `.bidsignore`), entities and file naming, DICOM-to-BIDS conversion with
HeuDiConv and dcm2bids, metadata sidecars, events files, the participants file,
derivatives, advanced PyBIDS usage, and running BIDS-Apps.

## Core Workflows

### 1. BIDS Directory Structure

A minimal BIDS dataset follows this layout:

```
my_dataset/
  dataset_description.json      # Required: name, BIDSVersion, etc.
  participants.tsv              # Recommended: subject-level phenotypic data
  participants.json             # Recommended: column descriptions
  README                        # Recommended: dataset documentation
  CHANGES                       # Recommended: version history
  .bidsignore                   # Optional: patterns to exclude from validation
  sub-01/
    anat/
      sub-01_T1w.nii.gz
      sub-01_T1w.json           # Sidecar metadata
    func/
      sub-01_task-rest_bold.nii.gz
      sub-01_task-rest_bold.json
      sub-01_task-rest_events.tsv     # Event timing for task fMRI
      sub-01_task-rest_events.json
    dwi/
      sub-01_dwi.nii.gz
      sub-01_dwi.json
      sub-01_dwi.bvec
      sub-01_dwi.bval
    fmap/
      sub-01_phasediff.nii.gz
      sub-01_phasediff.json
      sub-01_magnitude1.nii.gz
    perf/
      sub-01_asl.nii.gz
      sub-01_asl.json
  sub-01/
    ses-pre/
      anat/
        sub-01_ses-pre_T1w.nii.gz
      func/
        sub-01_ses-pre_task-nback_bold.nii.gz
    ses-post/
      ...
```

**Key points:**
- Every NIfTI file should have a corresponding `.json` sidecar
- File names encode entities: `sub-<label>[_ses-<label>][_task-<label>][_acq-<label>][_run-<index>]_<suffix>.<extension>`
- Entity order in filenames is fixed by the specification
- Only `dataset_description.json` is strictly required at the root level

### 2. Creating dataset_description.json

```python
import json

dataset_description = {
    "Name": "My Neuroimaging Study",
    "BIDSVersion": "1.10.0",
    "DatasetType": "raw",
    "License": "CC0",
    "Authors": ["First Author", "Second Author"],
    "Acknowledgements": "Funded by NIH R01-MH123456",
    "HowToAcknowledge": "Please cite: Author et al. (2025) Journal Name.",
    "Funding": ["NIH R01-MH123456", "NSF BCS-7654321"],
    "ReferencesAndLinks": ["https://doi.org/10.xxxx/xxxxx"],
    "DatasetDOI": "10.18112/openneuro.ds000001.v1.0.0",
    "GeneratedBy": [
        {
            "Name": "HeuDiConv",
            "Version": "1.3.1",
            "CodeURL": "https://github.com/nipy/heudiconv"
        }
    ]
}

with open("dataset_description.json", "w") as f:
    json.dump(dataset_description, f, indent=4)
```

For **derivatives**, set `"DatasetType": "derivative"` and add `"GeneratedBy"` listing the pipeline:

```python
deriv_description = {
    "Name": "fMRIPrep - fMRI PREProcessing",
    "BIDSVersion": "1.10.0",
    "DatasetType": "derivative",
    "GeneratedBy": [
        {
            "Name": "fMRIPrep",
            "Version": "24.1.0",
            "CodeURL": "https://github.com/nipreps/fmriprep"
        }
    ]
}
```

### 3. Querying BIDS Datasets with PyBIDS

```python
from bids import BIDSLayout

# Index a BIDS dataset (validates structure on load)
layout = BIDSLayout("/path/to/bids_dataset")

# Basic queries
subjects = layout.get_subjects()          # ['01', '02', '03', ...]
sessions = layout.get_sessions()          # ['pre', 'post'] or []
tasks = layout.get_tasks()                # ['rest', 'nback']
runs = layout.get_runs()                  # [1, 2] or []

# Find specific files
bold_files = layout.get(
    suffix="bold",
    extension=".nii.gz",
    return_type="filename"
)

# Filter by subject, task, session
nback_sub01 = layout.get(
    subject="01",
    task="nback",
    suffix="bold",
    extension=".nii.gz",
    return_type="filename"
)

# Get metadata from JSON sidecars (automatic inheritance)
metadata = layout.get_metadata("/path/to/sub-01/func/sub-01_task-rest_bold.nii.gz")
tr = metadata["RepetitionTime"]

# Get all entities for a file
entities = layout.get_entities()

# Build a path from entities using BIDSLayout
bids_file = layout.get(subject="01", suffix="T1w", extension=".nii.gz")[0]
print(bids_file.path)
print(bids_file.get_entities())
```

**Key points:**
- `BIDSLayout` indexes the entire dataset on initialization; for large datasets use `database_path` to cache the index
- Metadata inheritance: a JSON sidecar at a higher level (e.g., root or subject) is inherited by all files below unless overridden
- Use `return_type="filename"` for paths, `return_type="object"` (default) for `BIDSFile` objects

### 4. Validating BIDS Datasets

#### Using bids-validator via PyPI (recommended)

The `bids-validator-deno` PyPI package bundles the Deno-based validator as a standalone CLI:

```bash
# Install
uv pip install bids-validator-deno

# Validate a dataset
bids-validator /path/to/bids_dataset

# Ignore specific warnings/errors
bids-validator /path/to/bids_dataset --ignoreNiftiHeaders --ignoreSubjectConsistency
```

#### Using bids-validator via Deno directly

If Deno is already available, you can install or run the validator without PyPI:

```bash
# Install globally via Deno
deno install -g -A npm:bids-validator

# Or run without installing
deno run -A npm:bids-validator /path/to/bids_dataset
```

#### Legacy Node.js validator

The older Node.js-based validator (`npm install -g bids-validator`) is deprecated in favor of the Deno-based version. The Deno version is the reference implementation for BIDS Specification v1.9+.

#### Using .bidsignore

Create `.bidsignore` at the dataset root to exclude files from validation (gitignore syntax):

```
# Exclude sourcedata and extra files
sourcedata/
extra_data/
*.log
*_sbref.nii.gz
**/.DS_Store
```

### 5. BIDS Entities and File Naming

The authoritative, machine-readable source of truth for entities, their ordering, allowed suffixes, and all filename rules is the **BIDS Schema** — a structured YAML/JSON representation of the specification. A JSON export is shipped with this skill at `references/bids_schema.json`. The schema is defined in the [bids-specification `src/schema/`](https://github.com/bids-standard/bids-specification/tree/master/src/schema) directory and published at https://bids-specification.readthedocs.io/en/stable/schema.json. BEP-specific schema previews are available at https://github.com/bids-standard/bids-schema/tree/main/BEPs.

Run `scripts/update_schema.py` to refresh the schema and BEPs list from upstream (no dependencies beyond stdlib).

The tables below are a convenient summary; when in doubt, consult the schema.

BIDS filenames are built from ordered key-value entity pairs:

| Entity | Key | Example | Required for |
|--------|-----|---------|--------------|
| Subject | `sub-` | `sub-01` | All files |
| Session | `ses-` | `ses-pre` | Multi-session studies |
| Task | `task-` | `task-rest` | func (bold, cbv, phase), eeg, meg |
| Acquisition | `acq-` | `acq-highres` | Distinguishing acquisition parameters |
| Contrast enhancing agent | `ce-` | `ce-gadolinium` | Contrast-enhanced images |
| Reconstruction | `rec-` | `rec-magnitude` | Reconstruction variants |
| Direction | `dir-` | `dir-AP` | Fieldmaps, DWI, phase-encoding |
| Run | `run-` | `run-01` | Multiple identical acquisitions |
| Echo | `echo-` | `echo-1` | Multi-echo sequences |
| Part | `part-` | `part-mag` | Magnitude/phase splits |
| Space | `space-` | `space-MNI152NLin2009cAsym` | Derivatives in template space |
| Description | `desc-` | `desc-preproc` | Derivatives only |

**Entity ordering in filenames** is fixed by the spec (defined in `rules.entities` in `bids_schema.json`). See `references/bids_specification.md` for the complete numbered ordering table. A common subset:
`sub-<label>[_ses-<label>][_task-<label>][_acq-<label>][_ce-<label>][_rec-<label>][_dir-<label>][_run-<index>][_echo-<index>][_part-<label>][_space-<label>][_desc-<label>]_<suffix>.<extension>`

**Common suffixes by datatype:**

| Datatype | Suffixes |
|----------|----------|
| anat | `T1w`, `T2w`, `FLAIR`, `T2star`, `T1map`, `T2map`, `defacemask` |
| func | `bold`, `cbv`, `sbref`, `events`, `physio`, `stim` |
| dwi | `dwi`, `sbref` |
| fmap | `phasediff`, `phase1`, `phase2`, `magnitude1`, `magnitude2`, `fieldmap`, `epi` |
| perf | `asl`, `m0scan`, `aslcontext` |
| eeg | `eeg`, `channels`, `electrodes`, `events` |
| meg | `meg`, `channels`, `coordsystem`, `events` |
| ieeg | `ieeg`, `channels`, `electrodes`, `coordsystem`, `events` |
| pet | `pet`, `blood` |

### 6. DICOM to BIDS Conversion

#### HeuDiConv

HeuDiConv is the most flexible DICOM-to-BIDS converter. It supports three usage modes — from fully automatic to fully custom — and handles duplicates, provenance tracking, and sourcedata archiving out of the box.

**Mode 1: ReproIn (turnkey, recommended for new studies)**

If scanner protocol names follow the [ReproIn naming convention](https://github.com/repronim/reproin), conversion is fully automatic — no heuristic file to write:

```bash
# Turnkey conversion: HeuDiConv maps ReproIn protocol names to BIDS automatically
heudiconv --files dicom/001 -o /path/to/bids -f reproin --bids --minmeta
```

ReproIn protocol names encode BIDS entities directly:
- `anat-T1w` → `sub-XX/anat/sub-XX_T1w.nii.gz`
- `func-bold_task-rest` → `sub-XX/func/sub-XX_task-rest_bold.nii.gz`
- `dwi_dir-AP` → `sub-XX/dwi/sub-XX_dir-AP_dwi.nii.gz`
- `fmap_dir-PA` → `sub-XX/fmap/sub-XX_dir-PA_epi.nii.gz`

Session can be set once on the localizer (e.g., `anat-scout_ses-pre`) and ReproIn propagates it to all sequences in that Program. Subject ID is extracted from DICOM metadata. Duplicate runs are numbered automatically.

**Mode 2: Custom heuristic mapping into ReproIn (for existing data)**

If you already have data with non-ReproIn protocol names, you can write a thin heuristic that maps your names into ReproIn conventions, gaining all ReproIn benefits (automatic entity handling, duplicate management, etc.). See https://github.com/repronim/reproin/issues/18 for a HOWTO.

**Mode 3: Custom heuristic (full flexibility)**

For complex mappings, write a Python heuristic file:

```bash
# Step 1: Reconnaissance — discover DICOM series
heudiconv --files dicom/219/itbs/*/*.dcm -o Nifti/ -f convertall -s 219 -c none

# This creates .heudiconv/219/info/dicominfo.tsv — inspect it to understand
# what was acquired and map series to BIDS names.

# Step 2: Write a heuristic file (see references/conversion_tools.md)

# Step 3: Convert
heudiconv --files dicom/219/itbs/*/*.dcm -s 219 -ss itbs \
  -f Nifti/code/heuristic.py -c dcm2niix --bids --minmeta -o Nifti/
```

See `references/conversion_tools.md` for complete heuristic file examples.

**Key points:**
- HeuDiConv wraps `dcm2niix` for the actual DICOM-to-NIfTI conversion
- **`--minmeta`**: always use this flag to prevent excess DICOM metadata from overflowing JSON sidecars (can crash fMRIPrep/MRIQC)
- **Duplicate handling**: use `{item:03d}` in templates for auto-numbering when the same protocol is run multiple times; without it, later runs overwrite earlier ones
- **`.heudiconv/` directory**: created alongside output, stores provenance (heuristic used, dicominfo.tsv, conversion records). Keep it with your data for reproducibility
- **`sourcedata/`**: HeuDiConv archives original DICOMs as `.tgz` files under `sourcedata/` for reproducibility
- **`is_motion_corrected` filter**: use in heuristics to exclude scanner-generated MOCO series (e.g., `if not s.is_motion_corrected`)
- Both `--files` (explicit paths) and `-d` (template with `{subject}`, `{session}` placeholders) are supported for specifying DICOM input

#### dcm2bids (Configuration-file-based)

```bash
# Step 1: Generate helper output to inspect series
dcm2bids_helper -d /path/to/dicom

# Step 2: Create config file (dcm2bids_config.json)
# Step 3: Convert
dcm2bids -d /path/to/dicom -p 01 -c dcm2bids_config.json -o /path/to/bids_output
```

See `references/conversion_tools.md` for detailed configuration examples.

### 7. Metadata Sidecars

Every BIDS data file should have a JSON sidecar with acquisition parameters. Metadata fields follow the inheritance principle: a sidecar at a higher directory level applies to all matching files below.

**Inheritance example:**
```
my_dataset/
  task-rest_bold.json           # Applies to ALL rest BOLD files
  sub-01/
    func/
      sub-01_task-rest_bold.json  # Overrides/extends for sub-01 only
```

**Critical metadata fields by modality:**

For **func (BOLD)**:
```json
{
    "RepetitionTime": 2.0,
    "TaskName": "rest",
    "PhaseEncodingDirection": "j-",
    "TotalReadoutTime": 0.05,
    "SliceTiming": [0, 0.5, 1.0, 1.5],
    "EffectiveEchoSpacing": 0.00058,
    "EchoTime": 0.03
}
```

For **anat**:
```json
{
    "MagneticFieldStrength": 3,
    "Manufacturer": "Siemens",
    "ManufacturersModelName": "Prisma",
    "RepetitionTime": 2.3,
    "EchoTime": 0.00293,
    "FlipAngle": 8
}
```

For **DWI**:
```json
{
    "PhaseEncodingDirection": "j-",
    "TotalReadoutTime": 0.05,
    "EchoTime": 0.089,
    "RepetitionTime": 3.4,
    "MultipartID": "dwi_1"
}
```

**Key points:**
- `dcm2niix` auto-generates most sidecar fields from DICOM headers
- `RepetitionTime` and `TaskName` are required for BOLD
- `SliceTiming` is essential for slice-timing correction in fMRI preprocessing
- `PhaseEncodingDirection` and `TotalReadoutTime` (or `EffectiveEchoSpacing`) are needed for distortion correction
- See `references/metadata_fields.md` for comprehensive field reference

### 8. Events Files for Task fMRI

Task-based fMRI requires `_events.tsv` files:

```
onset	duration	trial_type	response_time
0.0	0.5	face	0.435
2.5	0.5	house	0.367
5.0	0.5	face	0.512
7.5	0.5	scrambled	0.298
```

**Required columns:**
- `onset` - onset time in seconds relative to the start of the acquisition
- `duration` - duration in seconds (use `n/a` for instantaneous events)

**Recommended columns:**
- `trial_type` - categorical label for condition
- `response_time` - RT in seconds
- Custom columns as needed (with descriptions in corresponding `.json` sidecar)

### 9. Participants File

```
participant_id	age	sex	group	handedness
sub-01	25	M	control	right
sub-02	30	F	patient	left
sub-03	28	M	control	right
```

The `participants.json` sidecar describes columns:

```json
{
    "age": {
        "Description": "Age of the participant at time of scanning",
        "Units": "years"
    },
    "sex": {
        "Description": "Biological sex",
        "Levels": {
            "M": "male",
            "F": "female"
        }
    },
    "group": {
        "Description": "Experimental group",
        "Levels": {
            "control": "Healthy control",
            "patient": "Patient group"
        }
    },
    "handedness": {
        "Description": "Dominant hand",
        "Levels": {
            "right": "Right-handed",
            "left": "Left-handed",
            "ambidextrous": "Ambidextrous"
        }
    }
}
```

### 10. BIDS Derivatives

Processed outputs go under a `derivatives/` directory:

```
my_dataset/
  derivatives/
    fmriprep-24.1.0/
      dataset_description.json      # DatasetType: "derivative"
      sub-01/
        anat/
          sub-01_space-MNI152NLin2009cAsym_desc-preproc_T1w.nii.gz
          sub-01_space-MNI152NLin2009cAsym_desc-brain_mask.nii.gz
        func/
          sub-01_task-rest_space-MNI152NLin2009cAsym_desc-preproc_bold.nii.gz
          sub-01_task-rest_desc-confounds_timeseries.tsv
    mriqc-24.0.0/
      dataset_description.json
      sub-01/
        anat/
          sub-01_T1w.html
        func/
          sub-01_task-rest_bold.html
      group_T1w.tsv
      group_bold.tsv
```

**Derivative conventions:**
- `space-<label>` - template/reference space (e.g., `MNI152NLin2009cAsym`, `T1w`)
- `desc-<label>` - description of processing (e.g., `preproc`, `brain`, `smoothed`)
- `res-<label>` - resolution (e.g., `2` for 2mm isotropic)
- Each pipeline gets its own directory under `derivatives/`
- Must have its own `dataset_description.json` with `GeneratedBy`

### 11. PyBIDS: Advanced Usage

```python
from bids import BIDSLayout
from bids.layout import BIDSLayoutIndexer

# Cache the layout index for faster repeated access
layout = BIDSLayout("/path/to/dataset", database_path="/path/to/cache.db")

# Include derivatives
layout = BIDSLayout(
    "/path/to/dataset",
    derivatives=["/path/to/dataset/derivatives/fmriprep-24.1.0"]
)

# Get derivative files
preproc = layout.get(
    subject="01",
    task="rest",
    desc="preproc",
    suffix="bold",
    space="MNI152NLin2009cAsym",
    extension=".nii.gz",
    return_type="filename"
)

# Get confound regressors
confounds = layout.get(
    subject="01",
    task="rest",
    desc="confounds",
    suffix="timeseries",
    extension=".tsv",
    return_type="filename"
)

# Build BIDS path from entities
from bids import BIDSLayout
layout = BIDSLayout("/path/to/dataset")
path = layout.build_path(
    {
        "subject": "01",
        "session": "pre",
        "task": "rest",
        "suffix": "bold",
        "extension": ".nii.gz",
        "datatype": "func"
    },
    validate=True
)

# Get all files for a subject as a DataFrame
import pandas as pd
files_df = layout.to_df()
sub01_df = files_df[files_df["subject"] == "01"]
```

### 12. BIDS-Apps

BIDS-Apps are containerized analysis pipelines that accept BIDS datasets as input:

```bash
# General BIDS-App invocation pattern
docker run -v /path/to/bids:/data:ro -v /path/to/output:/out \
    <bids-app-image> /data /out participant --participant_label 01

# Common BIDS-Apps:
# fMRIPrep - fMRI preprocessing
docker run nipreps/fmriprep /data /out participant \
    --participant-label 01 --fs-license-file /license.txt

# MRIQC - MRI quality control
docker run nipreps/mriqc /data /out participant \
    --participant-label 01

# QSIPrep - diffusion MRI preprocessing
docker run pennbbl/qsiprep /data /out participant \
    --participant-label 01
```

**BIDS-App interface convention:**
```
bids-app input_dataset output_dir {participant|group} [options]
```

- `participant` level: runs per-subject
- `group` level: runs across all subjects (aggregation/group stats)
