---
name: bioimage-analysis
description: Microscopy image analysis for cell biology. Cell segmentation (Cellpose, watershed), object tracking (trackpy), morphology quantification, colony counting, colocalization analysis, and cytoskeleton characterization. For pathology WSI use pathml; for flow cytometry use flow-cytometry-analysis.
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Bioimage Analysis: Microscopy Image Analysis for Cell Biology

## Overview

Bioimage Analysis provides computational tools for processing and quantifying microscopy images in cell biology research. From cell segmentation using deep learning (Cellpose) and classical methods (watershed, Otsu thresholding) to object tracking across time-lapse sequences, morphology quantification, colony counting, colocalization analysis, and cytoskeleton characterization. This skill covers the full pipeline from raw microscopy images to quantitative measurements suitable for statistical analysis.

## When to Use This Skill

- Segmenting cells or nuclei from brightfield or fluorescence microscopy images
- Tracking cell migration or particle movement in time-lapse sequences
- Quantifying cell morphology (area, eccentricity, circularity, aspect ratio)
- Counting bacterial or mammalian cell colonies on plates
- Analyzing colocalization of proteins from multi-channel fluorescence images
- Characterizing cytoskeleton fiber orientation and alignment
- Quantifying mitochondrial morphology from JC-1 or TMRM staining
- Batch processing multiple fields of view or multi-well plate images
- Preprocessing microscopy images (denoising, background subtraction, contrast enhancement)

**Related Skills:** For whole-slide pathology image analysis use `pathml` or `histolab`. For flow cytometry data use `flow-cytometry-analysis`. For clinical imaging (MRI, CT) use `clinical-imaging`.

## Installation

```bash
uv pip install cellpose scikit-image opencv-python trackpy tifffile aicsimageio numpy pandas matplotlib
```

## Quick Start

```python
from cellpose import models
import skimage.io
import skimage.measure
import numpy as np

# Load image
image = skimage.io.imread('cells.tif')

# Segment with Cellpose
model = models.Cellpose(model_type='cyto2')
masks, flows, styles, diams = model.eval(image, diameter=None, channels=[0, 0])

# Measure properties
props = skimage.measure.regionprops_table(masks, image,
    properties=['label', 'area', 'eccentricity', 'mean_intensity'])

import pandas as pd
df = pd.DataFrame(props)
print(f"Detected {len(df)} cells")
print(df.describe())
```

## Core Capabilities

### 1. Image Loading & Preprocessing

Load microscopy images from common formats and prepare them for analysis.

```python
import tifffile
import skimage.io
import skimage.filters
import skimage.exposure
import numpy as np

# Load multi-channel TIFF
image = tifffile.imread('experiment.tif')
print(f"Shape: {image.shape}, dtype: {image.dtype}")

# For multi-dimensional images (TCZYX)
from aicsimageio import AICSImage
img = AICSImage('multi_dim.czi')
data = img.get_image_data("ZYX", C=0, T=0)

# Contrast enhancement (CLAHE)
enhanced = skimage.exposure.equalize_adapthist(image, clip_limit=0.03)

# Gaussian denoising
denoised = skimage.filters.gaussian(image, sigma=1.0)

# Background subtraction (rolling ball approximation)
from skimage.morphology import white_tophat, disk
background_removed = white_tophat(image, disk(50))

# Median filter for salt-and-pepper noise
from skimage.filters import median
from skimage.morphology import square
cleaned = median(image, square(3))
```

### 2. Cell Segmentation

Segment individual cells using deep learning or classical approaches.

**Cellpose (deep learning):**

```python
from cellpose import models

# Cytoplasm segmentation
model = models.Cellpose(model_type='cyto2')
masks, flows, styles, diams = model.eval(
    image,
    diameter=None,       # Auto-detect cell diameter
    channels=[0, 0],     # Grayscale; [2,3] for green cytoplasm + blue nuclei
    flow_threshold=0.4,
    cellprob_threshold=0.0
)

# Nuclei-only segmentation
nuc_model = models.Cellpose(model_type='nuclei')
nuc_masks, _, _, _ = nuc_model.eval(image, diameter=None, channels=[0, 0])

print(f"Segmented {masks.max()} cells")
```

**Classical watershed:**

```python
import skimage.segmentation
import skimage.feature
import skimage.filters
import skimage.morphology
from scipy import ndimage

# Threshold
thresh = skimage.filters.threshold_otsu(image)
binary = image > thresh

# Distance transform for watershed seeds
distance = ndimage.distance_transform_edt(binary)
local_max = skimage.feature.peak_local_max(distance, min_distance=20, labels=binary)
markers = np.zeros_like(image, dtype=int)
for i, (r, c) in enumerate(local_max, start=1):
    markers[r, c] = i
markers = ndimage.label(markers)[0]

# Watershed
labels = skimage.segmentation.watershed(-distance, markers, mask=binary)
print(f"Segmented {labels.max()} objects")
```

**Adaptive thresholding:**

```python
# For uneven illumination
block_size = 51
adaptive_thresh = skimage.filters.threshold_local(image, block_size, offset=10)
binary = image > adaptive_thresh

# Connected component labeling
from skimage.measure import label
labeled = label(binary)
print(f"Found {labeled.max()} connected components")
```

### 3. Object Tracking

Track cells or particles across time-lapse frames.

```python
import trackpy as tp
import pandas as pd

# Load time-lapse as 3D array (T, Y, X)
frames = tifffile.imread('timelapse.tif')

# Locate features in each frame
all_features = []
for t, frame in enumerate(frames):
    features = tp.locate(frame, diameter=11, minmass=1000)
    features['frame'] = t
    all_features.append(features)

features_df = pd.concat(all_features, ignore_index=True)

# Link particles across frames
trajectories = tp.link(features_df, search_range=15, memory=3)

# Filter spurious tracks (require minimum length)
trajectories = tp.filter_stubs(trajectories, threshold=10)
print(f"Tracked {trajectories['particle'].nunique()} objects over {len(frames)} frames")

# Calculate mean squared displacement
msd = tp.emsd(trajectories, mpp=0.65, fps=1)  # microns per pixel, frames per second
print(msd.head())
```

### 4. Morphology Quantification

Extract shape and intensity measurements from segmented objects.

```python
import skimage.measure
import pandas as pd

# Measure region properties
props = skimage.measure.regionprops_table(masks, intensity_image=image,
    properties=[
        'label', 'area', 'perimeter', 'eccentricity', 'solidity',
        'major_axis_length', 'minor_axis_length', 'mean_intensity',
        'max_intensity', 'min_intensity', 'centroid'
    ])

df = pd.DataFrame(props)

# Calculate derived metrics
df['circularity'] = 4 * np.pi * df['area'] / (df['perimeter'] ** 2)
df['aspect_ratio'] = df['major_axis_length'] / df['minor_axis_length']

print(f"Measured {len(df)} objects")
print(df[['area', 'eccentricity', 'circularity', 'mean_intensity']].describe())
```

### 5. Colony Counting

Count colonies from plate images.

```python
import skimage.io
import skimage.filters
import skimage.segmentation
import skimage.measure
from scipy import ndimage

# Load plate image
plate = skimage.io.imread('agar_plate.jpg', as_gray=True)

# Preprocessing
smoothed = skimage.filters.gaussian(plate, sigma=2)

# Threshold
thresh = skimage.filters.threshold_otsu(smoothed)
binary = smoothed < thresh  # Colonies are darker

# Remove small noise
from skimage.morphology import remove_small_objects
cleaned = remove_small_objects(binary, min_size=50)

# Separate touching colonies with watershed
distance = ndimage.distance_transform_edt(cleaned)
local_max = skimage.feature.peak_local_max(distance, min_distance=10, labels=cleaned)
markers = np.zeros_like(plate, dtype=int)
for i, (r, c) in enumerate(local_max, start=1):
    markers[r, c] = i
markers = ndimage.label(markers)[0]
separated = skimage.segmentation.watershed(-distance, markers, mask=cleaned)

# Count and measure
regions = skimage.measure.regionprops(separated)
colony_count = len(regions)
areas = [r.area for r in regions]
print(f"Colony count: {colony_count}")
print(f"Mean colony area: {np.mean(areas):.1f} px^2")
```

### 6. Colocalization Analysis

Quantify spatial overlap between fluorescence channels.

```python
import numpy as np
from scipy.stats import pearsonr

# Load dual-channel image
ch1 = skimage.io.imread('green_channel.tif').astype(float)
ch2 = skimage.io.imread('red_channel.tif').astype(float)

# Mask background (Costes automatic thresholding approximation)
mask = (ch1 > skimage.filters.threshold_otsu(ch1)) | \
       (ch2 > skimage.filters.threshold_otsu(ch2))

ch1_masked = ch1[mask]
ch2_masked = ch2[mask]

# Pearson correlation coefficient
pcc, pval = pearsonr(ch1_masked, ch2_masked)
print(f"Pearson correlation: {pcc:.4f} (p={pval:.2e})")

# Manders overlap coefficients
ch1_coloc = ch1_masked[ch2_masked > 0]
ch2_coloc = ch2_masked[ch1_masked > 0]
M1 = ch1_coloc.sum() / ch1_masked.sum()  # Fraction of ch1 overlapping with ch2
M2 = ch2_coloc.sum() / ch2_masked.sum()  # Fraction of ch2 overlapping with ch1
print(f"Manders M1: {M1:.4f}, M2: {M2:.4f}")
```

### 7. Cytoskeleton & Fiber Analysis

Characterize fiber orientation and alignment.

```python
import skimage.feature
import skimage.transform
import numpy as np

# Edge detection
edges = skimage.feature.canny(image, sigma=2)

# Hough line transform for fiber orientation
tested_angles = np.linspace(-np.pi / 2, np.pi / 2, 180, endpoint=False)
h, theta, d = skimage.transform.hough_line(edges, theta=tested_angles)

# Extract peaks (dominant orientations)
peaks = skimage.transform.hough_line_peaks(h, theta, d, num_peaks=50)

# Orientation distribution
angles_deg = np.degrees(peaks[1])
mean_angle = np.mean(angles_deg)
std_angle = np.std(angles_deg)

# Order parameter S = 2 * <cos^2(theta)> - 1 (1=aligned, 0=random)
cos2 = np.cos(2 * np.radians(angles_deg))
order_parameter = np.mean(cos2)
print(f"Mean orientation: {mean_angle:.1f} +/- {std_angle:.1f} degrees")
print(f"Order parameter S: {order_parameter:.3f}")
```

### 8. Mitochondrial Morphology

Analyze mitochondrial shape and membrane potential.

```python
import skimage.measure
import numpy as np

# JC-1 staining: red=healthy (aggregate), green=depolarized (monomer)
red_channel = skimage.io.imread('jc1_red.tif').astype(float)
green_channel = skimage.io.imread('jc1_green.tif').astype(float)

# Membrane potential ratio
ratio = red_channel / (green_channel + 1e-6)  # Avoid division by zero
mean_ratio = np.mean(ratio[ratio > 0])
print(f"Mean red/green ratio: {mean_ratio:.3f}")

# Segment mitochondria from green channel
thresh = skimage.filters.threshold_otsu(green_channel)
mito_mask = green_channel > thresh
mito_labels = skimage.measure.label(mito_mask)

# Morphology metrics
props = skimage.measure.regionprops_table(mito_labels,
    properties=['label', 'area', 'major_axis_length', 'minor_axis_length',
                'eccentricity', 'euler_number'])
df = pd.DataFrame(props)
df['aspect_ratio'] = df['major_axis_length'] / (df['minor_axis_length'] + 1e-6)

# Classify: round (AR<2), intermediate (2-4), elongated (>4)
df['morphology'] = pd.cut(df['aspect_ratio'], bins=[0, 2, 4, np.inf],
                          labels=['round', 'intermediate', 'elongated'])
print(df['morphology'].value_counts())
```

### 9. Batch Processing

Process multiple fields of view or wells.

```python
from pathlib import Path
import pandas as pd

image_dir = Path('plate_images/')
all_results = []

for img_path in sorted(image_dir.glob('*.tif')):
    image = skimage.io.imread(str(img_path))

    # Segment
    model = models.Cellpose(model_type='cyto2')
    masks, _, _, _ = model.eval(image, diameter=None, channels=[0, 0])

    # Measure
    props = skimage.measure.regionprops_table(masks, image,
        properties=['label', 'area', 'eccentricity', 'mean_intensity'])
    df = pd.DataFrame(props)
    df['image'] = img_path.stem

    all_results.append(df)

results = pd.concat(all_results, ignore_index=True)
summary = results.groupby('image').agg(
    cell_count=('label', 'count'),
    mean_area=('area', 'mean'),
    mean_intensity=('mean_intensity', 'mean')
).reset_index()
print(summary)
```

## Typical Workflows

### Workflow 1: Segment and Count Cells from Brightfield Microscopy

```python
from cellpose import models
import skimage.io, skimage.measure
import pandas as pd

# Load
image = skimage.io.imread('brightfield_cells.tif')

# Segment
model = models.Cellpose(model_type='cyto2')
masks, _, _, diams = model.eval(image, diameter=None, channels=[0, 0])

# Quantify
props = skimage.measure.regionprops_table(masks, image,
    properties=['label', 'area', 'eccentricity', 'mean_intensity', 'centroid'])
df = pd.DataFrame(props)
print(f"Cell count: {masks.max()}")
print(f"Mean area: {df['area'].mean():.1f} px^2")
print(f"Mean eccentricity: {df['eccentricity'].mean():.3f}")
```

### Workflow 2: Track Cell Migration and Compute Velocity

```python
import trackpy as tp
import tifffile
import numpy as np

# Load time-lapse
frames = tifffile.imread('migration_timelapse.tif')
pixel_size = 0.65  # um/px
dt = 5  # minutes between frames

# Detect and track
features = tp.batch(frames, diameter=15, minmass=500)
tracks = tp.link(features, search_range=20, memory=3)
tracks = tp.filter_stubs(tracks, threshold=10)

# Calculate velocity per track
velocities = []
for pid, group in tracks.groupby('particle'):
    group = group.sort_values('frame')
    dx = np.diff(group['x'].values) * pixel_size
    dy = np.diff(group['y'].values) * pixel_size
    speed = np.sqrt(dx**2 + dy**2) / dt  # um/min
    velocities.append({'particle': pid, 'mean_speed': np.mean(speed),
                       'max_speed': np.max(speed), 'n_frames': len(group)})

vel_df = pd.DataFrame(velocities)
print(f"Mean migration speed: {vel_df['mean_speed'].mean():.3f} um/min")
```

### Workflow 3: Quantify Protein Colocalization from Dual-Channel Fluorescence

```python
import skimage.io
import numpy as np
from scipy.stats import pearsonr

# Load channels
green = skimage.io.imread('protein_A_green.tif').astype(float)
red = skimage.io.imread('protein_B_red.tif').astype(float)

# Background subtraction
green -= np.percentile(green, 5)
red -= np.percentile(red, 5)
green = np.clip(green, 0, None)
red = np.clip(red, 0, None)

# Threshold mask
mask = (green > green.mean()) | (red > red.mean())
g_masked, r_masked = green[mask], red[mask]

# Pearson
pcc, pval = pearsonr(g_masked, r_masked)

# Manders
M1 = g_masked[r_masked > 0].sum() / g_masked.sum()
M2 = r_masked[g_masked > 0].sum() / r_masked.sum()

print(f"Pearson r = {pcc:.4f} (p = {pval:.2e})")
print(f"Manders M1 = {M1:.4f}, M2 = {M2:.4f}")
```

### Workflow 4: Count Bacterial Colonies on Agar Plate Image

```python
import skimage.io, skimage.filters, skimage.measure
from skimage.morphology import remove_small_objects
from scipy import ndimage
import numpy as np

plate = skimage.io.imread('agar_plate.jpg', as_gray=True)
smoothed = skimage.filters.gaussian(plate, sigma=2)
binary = smoothed < skimage.filters.threshold_otsu(smoothed)
binary = remove_small_objects(binary, min_size=30)

# Watershed to split touching colonies
distance = ndimage.distance_transform_edt(binary)
from skimage.feature import peak_local_max
local_max = peak_local_max(distance, min_distance=8, labels=binary)
markers = np.zeros_like(binary, dtype=int)
for i, (r, c) in enumerate(local_max, start=1):
    markers[r, c] = i
markers = ndimage.label(markers)[0]
labels = skimage.segmentation.watershed(-distance, markers, mask=binary)

regions = skimage.measure.regionprops(labels)
print(f"Colony count: {len(regions)}")
print(f"Mean area: {np.mean([r.area for r in regions]):.0f} px^2")
```

## Best Practices

1. **Always inspect images first** — check bit depth, dimensions, and channel order before processing
2. **Use appropriate preprocessing** — CLAHE for low contrast, Gaussian blur for noisy images, background subtraction for uneven illumination
3. **Validate segmentation visually** — overlay masks on original images to verify quality before batch processing
4. **Cellpose model selection** — use `cyto2` for whole-cell, `nuclei` for nuclear segmentation; adjust `diameter` parameter if auto-detection fails
5. **Trackpy parameter tuning** — `diameter` must be odd integer; `search_range` should be < typical inter-particle distance; use `memory` for blinking objects
6. **Colocalization controls** — always include single-stained controls; report both Pearson and Manders coefficients
7. **Batch consistency** — use identical preprocessing and segmentation parameters across all images in an experiment
8. **Scale bars** — always record pixel size (um/px) from microscope metadata for absolute measurements

## Troubleshooting

**Problem:** Cellpose segments too many or too few cells
**Solution:** Adjust `diameter` parameter manually instead of auto-detection. Increase `cellprob_threshold` (e.g., 0.5) to reduce false positives, decrease for more detections.

**Problem:** Touching colonies not separated by watershed
**Solution:** Decrease `min_distance` in `peak_local_max`. Try morphological erosion before distance transform.

**Problem:** Trackpy links wrong particles across frames
**Solution:** Decrease `search_range` to limit maximum displacement. Increase `minmass` to exclude dim objects that cause mislinks.

**Problem:** TIFF file won't load or has wrong dimensions
**Solution:** Use `tifffile.imread` for raw loading. Check `image.shape` and `image.dtype`. For multi-series files use `aicsimageio`.

**Problem:** Colocalization values seem artificially high
**Solution:** Ensure proper background subtraction. Use Costes automatic thresholding. Check for bleed-through between channels.

## Resources

- [Cellpose Documentation](https://cellpose.readthedocs.io/)
- [scikit-image Documentation](https://scikit-image.org/docs/stable/)
- [trackpy Documentation](http://soft-matter.github.io/trackpy/)
- [AICS ImageIO](https://allencellmodeling.github.io/aicsimageio/)
- [Bio-image Analysis Notebooks](https://haesleinhuepf.github.io/BioImageAnalysisNotebooks/)
