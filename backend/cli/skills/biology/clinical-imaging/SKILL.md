---
name: clinical-imaging
description: Clinical and physiological imaging analysis. Diffusion MRI ADC maps, micro-CT bone morphometry, hemodynamic parameter analysis, circadian rhythm cosinor analysis, ciliary beat frequency (FFT), and tissue deformation optical flow. For DICOM file handling use pydicom; for biosignals use neurokit2.
category: biology
license: MIT license
metadata:
    skill-author: InkVell Inc.
---

# Clinical Imaging: Clinical & Physiological Imaging Analysis

## Overview

Clinical Imaging provides computational tools for analyzing clinical and physiological imaging data. This skill covers diffusion MRI apparent diffusion coefficient (ADC) map computation, micro-CT bone morphometry (BV/TV, trabecular thickness), hemodynamic parameter analysis from blood pressure waveforms, circadian rhythm cosinor analysis, ciliary beat frequency measurement via FFT, tissue deformation analysis using optical flow, and amyloid plaque quantification from fluorescence microscopy.

## When to Use This Skill

- Computing ADC maps from multi-b-value diffusion MRI data
- Analyzing bone microarchitecture from micro-CT volumes
- Processing blood pressure or hemodynamic waveform data
- Fitting circadian rhythm data with cosinor models
- Measuring ciliary beat frequency from high-speed video
- Quantifying tissue deformation from image sequences
- Counting and measuring amyloid plaques in fluorescence images

**Related Skills:** For DICOM file handling use `pydicom`. For biosignal processing (ECG, EMG, EDA) use `neurokit2`. For general image analysis use `bioimage-analysis`.

## Installation

```bash
uv pip install nibabel SimpleITK scipy opencv-python scikit-image numpy pandas matplotlib
```

## Quick Start

```python
import numpy as np
from scipy.optimize import curve_fit

# Circadian rhythm cosinor analysis
def cosinor(t, mesor, amplitude, acrophase, period=24):
    return mesor + amplitude * np.cos(2 * np.pi * t / period + acrophase)

# Example: body temperature over 48 hours
time_hours = np.arange(0, 48, 1)
temperature = 36.8 + 0.3 * np.cos(2 * np.pi * time_hours / 24 - 1.0) + \
              np.random.normal(0, 0.1, len(time_hours))

popt, pcov = curve_fit(cosinor, time_hours, temperature,
                       p0=[36.8, 0.3, -1.0], maxfev=10000)
print(f"MESOR: {popt[0]:.2f} C")
print(f"Amplitude: {popt[1]:.3f} C")
print(f"Acrophase: {np.degrees(popt[2]):.1f} degrees ({popt[2]/(2*np.pi)*24:.1f} h)")
```

## Core Capabilities

### 1. Diffusion MRI ADC Maps

Compute apparent diffusion coefficient maps from multi-b-value images.

```python
import nibabel as nib
import numpy as np

def compute_adc_map(dwi_paths, b_values):
    """Compute ADC map from multi-b-value DWI images.

    ADC = -ln(S/S0) / b, where S0 is the b=0 image.

    Args:
        dwi_paths: list of NIfTI file paths (one per b-value)
        b_values: list of b-values in s/mm²
    """
    # Load images
    images = [nib.load(p).get_fdata() for p in dwi_paths]
    b_values = np.array(b_values)

    # Identify b=0 image
    b0_idx = np.argmin(b_values)
    S0 = images[b0_idx].astype(float)
    S0[S0 == 0] = 1e-10  # Avoid division by zero

    # Compute ADC using linear regression in log space
    # ln(S) = ln(S0) - b * ADC
    shape = S0.shape
    adc_map = np.zeros(shape)

    # Use non-zero b-values
    nonzero_mask = b_values > 0
    b_nonzero = b_values[nonzero_mask]

    for idx, (img, b) in enumerate(zip(images, b_values)):
        if b > 0:
            ratio = img.astype(float) / S0
            ratio = np.clip(ratio, 1e-10, None)
            adc_contribution = -np.log(ratio) / b
            adc_map += adc_contribution

    adc_map /= nonzero_mask.sum()

    # Mask out background (where S0 is very low)
    tissue_mask = S0 > np.percentile(S0[S0 > 0], 10)
    adc_map[~tissue_mask] = 0

    # Clip to physiological range (0 - 3.5 x 10^-3 mm²/s)
    adc_map = np.clip(adc_map, 0, 3.5e-3)

    print(f"ADC map shape: {adc_map.shape}")
    print(f"Mean ADC (tissue): {adc_map[tissue_mask].mean()*1e3:.3f} x10⁻³ mm²/s")
    print(f"Median ADC (tissue): {np.median(adc_map[tissue_mask])*1e3:.3f} x10⁻³ mm²/s")

    return adc_map, tissue_mask

def regional_adc_stats(adc_map, roi_mask):
    """Calculate ADC statistics within a region of interest."""
    roi_values = adc_map[roi_mask & (adc_map > 0)]
    return {
        'mean': roi_values.mean() * 1e3,
        'median': np.median(roi_values) * 1e3,
        'std': roi_values.std() * 1e3,
        'min': roi_values.min() * 1e3,
        'max': roi_values.max() * 1e3,
        'n_voxels': len(roi_values),
        'unit': '10⁻³ mm²/s'
    }
```

### 2. Micro-CT Bone Morphometry

Quantify bone microarchitecture from 3D micro-CT volumes.

```python
import numpy as np
from scipy import ndimage
import skimage.filters

def bone_morphometry(volume, voxel_size_um, roi_mask=None):
    """Compute trabecular bone morphometric parameters.

    Args:
        volume: 3D numpy array (micro-CT volume)
        voxel_size_um: voxel size in micrometers
        roi_mask: optional ROI mask (binary 3D array)
    """
    if roi_mask is not None:
        vol = volume * roi_mask
    else:
        vol = volume.copy()
        roi_mask = np.ones_like(volume, dtype=bool)

    # Segment bone (Otsu thresholding)
    threshold = skimage.filters.threshold_otsu(vol[roi_mask])
    bone_mask = vol > threshold

    # BV/TV: Bone Volume / Total Volume
    total_voxels = roi_mask.sum()
    bone_voxels = (bone_mask & roi_mask).sum()
    bv_tv = bone_voxels / total_voxels

    # Trabecular Thickness (Tb.Th) via distance transform
    # Mean thickness = 2 * mean distance transform value within bone
    bone_distance = ndimage.distance_transform_edt(bone_mask & roi_mask)
    tb_th = 2 * bone_distance[bone_mask & roi_mask].mean() * voxel_size_um / 1000  # mm

    # Trabecular Spacing (Tb.Sp) via distance transform of marrow
    marrow_mask = ~bone_mask & roi_mask
    marrow_distance = ndimage.distance_transform_edt(marrow_mask)
    tb_sp = 2 * marrow_distance[marrow_mask].mean() * voxel_size_um / 1000  # mm

    # Trabecular Number (Tb.N)
    tb_n = bv_tv / tb_th if tb_th > 0 else 0  # 1/mm

    # Cortical thickness (if applicable)
    # Use morphological operations to identify cortex
    from skimage.morphology import binary_erosion, ball
    eroded = binary_erosion(bone_mask & roi_mask, ball(3))
    cortex = (bone_mask & roi_mask) & ~eroded
    cortex_dist = ndimage.distance_transform_edt(cortex)
    ct_th = cortex_dist[cortex].mean() * voxel_size_um / 1000 if cortex.sum() > 0 else 0

    results = {
        'BV/TV': bv_tv,
        'Tb.Th (mm)': tb_th,
        'Tb.Sp (mm)': tb_sp,
        'Tb.N (1/mm)': tb_n,
        'Ct.Th (mm)': ct_th,
        'bone_voxels': bone_voxels,
        'total_voxels': total_voxels
    }

    for key, val in results.items():
        if isinstance(val, float):
            print(f"{key}: {val:.4f}")

    return results
```

### 3. Hemodynamic Analysis

Process blood pressure waveforms.

```python
import numpy as np
from scipy.signal import find_peaks

def analyze_blood_pressure(pressure_signal, sampling_rate_hz):
    """Analyze blood pressure waveform.

    Args:
        pressure_signal: 1D array of pressure values (mmHg)
        sampling_rate_hz: sampling frequency
    """
    # Detect systolic peaks
    min_distance = int(0.5 * sampling_rate_hz)  # Min 0.5s between beats
    peaks, props = find_peaks(pressure_signal, distance=min_distance,
                               prominence=20, height=60)

    # Detect diastolic troughs
    troughs, _ = find_peaks(-pressure_signal, distance=min_distance)

    # Systolic and diastolic pressures
    systolic = pressure_signal[peaks]
    # Match each peak to next trough
    diastolic = []
    for p in peaks:
        next_troughs = troughs[troughs > p]
        if len(next_troughs) > 0:
            diastolic.append(pressure_signal[next_troughs[0]])

    diastolic = np.array(diastolic[:len(systolic)])

    # Pulse pressure
    pulse_pressure = systolic[:len(diastolic)] - diastolic

    # Mean arterial pressure (MAP)
    map_pressure = diastolic + pulse_pressure / 3

    # Heart rate
    rr_intervals = np.diff(peaks) / sampling_rate_hz  # seconds
    heart_rate = 60 / rr_intervals  # BPM

    results = {
        'systolic_mean': np.mean(systolic),
        'systolic_std': np.std(systolic),
        'diastolic_mean': np.mean(diastolic),
        'diastolic_std': np.std(diastolic),
        'pulse_pressure_mean': np.mean(pulse_pressure),
        'MAP_mean': np.mean(map_pressure),
        'heart_rate_mean': np.mean(heart_rate),
        'heart_rate_std': np.std(heart_rate),
        'n_beats': len(peaks)
    }

    print(f"BP: {results['systolic_mean']:.0f}/{results['diastolic_mean']:.0f} mmHg")
    print(f"MAP: {results['MAP_mean']:.0f} mmHg")
    print(f"HR: {results['heart_rate_mean']:.0f} ± {results['heart_rate_std']:.0f} BPM")
    print(f"Pulse pressure: {results['pulse_pressure_mean']:.0f} mmHg")

    return results
```

### 4. Circadian Rhythm Cosinor

Fit circadian data with cosinor model.

```python
import numpy as np
from scipy.optimize import curve_fit
from scipy import stats

def cosinor_analysis(time_hours, measurements, period=24):
    """Cosinor analysis: Y = MESOR + Amplitude * cos(2*pi*t/T + acrophase).

    Args:
        time_hours: time points in hours
        measurements: observed values
        period: assumed period in hours (default: 24)
    """
    def cosinor(t, mesor, amplitude, acrophase):
        return mesor + amplitude * np.cos(2 * np.pi * t / period + acrophase)

    # Initial estimates
    mesor_init = np.mean(measurements)
    amp_init = (np.max(measurements) - np.min(measurements)) / 2
    acro_init = 0

    popt, pcov = curve_fit(cosinor, time_hours, measurements,
                           p0=[mesor_init, amp_init, acro_init],
                           maxfev=10000)
    perr = np.sqrt(np.diag(pcov))

    mesor, amplitude, acrophase = popt

    # Ensure amplitude is positive
    if amplitude < 0:
        amplitude = -amplitude
        acrophase += np.pi

    # Normalize acrophase to [0, 2*pi]
    acrophase = acrophase % (2 * np.pi)

    # R-squared
    predicted = cosinor(time_hours, *popt)
    ss_res = np.sum((measurements - predicted) ** 2)
    ss_tot = np.sum((measurements - np.mean(measurements)) ** 2)
    r_squared = 1 - ss_res / ss_tot

    # F-test for rhythm significance
    n = len(measurements)
    f_stat = (ss_tot - ss_res) / 2 / (ss_res / (n - 3))
    p_value = 1 - stats.f.cdf(f_stat, 2, n - 3)

    # Convert acrophase to clock time
    acrophase_hours = (-acrophase / (2 * np.pi) * period) % period
    acro_h = int(acrophase_hours)
    acro_m = int((acrophase_hours - acro_h) * 60)

    results = {
        'MESOR': mesor,
        'amplitude': amplitude,
        'acrophase_rad': acrophase,
        'acrophase_hours': acrophase_hours,
        'acrophase_clock': f"{acro_h:02d}:{acro_m:02d}",
        'period': period,
        'r_squared': r_squared,
        'f_statistic': f_stat,
        'p_value': p_value,
        'significant': p_value < 0.05
    }

    print(f"MESOR: {mesor:.3f} ± {perr[0]:.3f}")
    print(f"Amplitude: {amplitude:.3f} ± {perr[1]:.3f}")
    print(f"Acrophase: {results['acrophase_clock']} ({acrophase_hours:.1f} h)")
    print(f"R²: {r_squared:.4f}")
    print(f"Rhythm p-value: {p_value:.2e} ({'significant' if p_value < 0.05 else 'not significant'})")

    return results
```

### 5. Ciliary Beat Frequency

Measure CBF from high-speed video using FFT.

```python
import numpy as np
import cv2

def measure_ciliary_beat_frequency(video_path, fps, roi=None):
    """Measure ciliary beat frequency from high-speed video via FFT.

    Args:
        video_path: path to video file
        fps: frames per second of recording
        roi: (x, y, w, h) region of interest tuple, or None for full frame
    """
    cap = cv2.VideoCapture(video_path)
    frames = []

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if roi:
            x, y, w, h = roi
            gray = gray[y:y+h, x:x+w]
        frames.append(gray.astype(float))

    cap.release()
    frames = np.array(frames)
    n_frames = len(frames)
    print(f"Loaded {n_frames} frames at {fps} fps ({n_frames/fps:.1f} seconds)")

    # Mean intensity time series per pixel
    mean_intensity = frames.mean(axis=(1, 2))

    # FFT of mean intensity
    fft_vals = np.fft.rfft(mean_intensity - mean_intensity.mean())
    freqs = np.fft.rfftfreq(n_frames, d=1/fps)
    power = np.abs(fft_vals) ** 2

    # Find dominant frequency (excluding DC and very low frequencies)
    min_freq_idx = max(1, int(2 * n_frames / fps))  # Ignore < 2 Hz
    max_freq_idx = len(freqs) - 1

    dominant_idx = min_freq_idx + np.argmax(power[min_freq_idx:max_freq_idx])
    cbf = freqs[dominant_idx]

    print(f"Dominant ciliary beat frequency: {cbf:.1f} Hz")
    print(f"Period: {1/cbf*1000:.1f} ms")

    # Spatiotemporal frequency map
    cbf_map = np.zeros(frames[0].shape)
    for y in range(0, frames.shape[1], 4):
        for x in range(0, frames.shape[2], 4):
            pixel_ts = frames[:, y, x]
            pixel_fft = np.fft.rfft(pixel_ts - pixel_ts.mean())
            pixel_power = np.abs(pixel_fft) ** 2
            peak_idx = min_freq_idx + np.argmax(pixel_power[min_freq_idx:max_freq_idx])
            cbf_map[y, x] = freqs[peak_idx]

    return cbf, cbf_map, freqs, power
```

### 6. Tissue Deformation Flow

Quantify tissue deformation using optical flow.

```python
import cv2
import numpy as np

def analyze_tissue_deformation(frame1, frame2, method='lucas_kanade'):
    """Compute optical flow between two tissue images.

    Args:
        frame1, frame2: consecutive grayscale frames
        method: 'lucas_kanade' or 'farneback'
    """
    if method == 'farneback':
        flow = cv2.calcOpticalFlowFarneback(
            frame1, frame2, None,
            pyr_scale=0.5, levels=3, winsize=15,
            iterations=3, poly_n=5, poly_sigma=1.2, flags=0
        )
    else:  # Lucas-Kanade (sparse)
        pts = cv2.goodFeaturesToTrack(frame1, maxCorners=500,
                                      qualityLevel=0.01, minDistance=10)
        if pts is None:
            return None

        pts_new, status, err = cv2.calcOpticalFlowPyrLK(frame1, frame2, pts, None)
        good_old = pts[status.ravel() == 1]
        good_new = pts_new[status.ravel() == 1]

        # Compute displacement field
        dx = good_new[:, 0] - good_old[:, 0]
        dy = good_new[:, 1] - good_old[:, 1]
        magnitude = np.sqrt(dx**2 + dy**2)

        print(f"Tracked {len(good_old)} points")
        print(f"Mean displacement: {magnitude.mean():.2f} px")
        print(f"Max displacement: {magnitude.max():.2f} px")

        return {'dx': dx, 'dy': dy, 'magnitude': magnitude,
                'old_pts': good_old, 'new_pts': good_new}

    # For dense flow (Farneback)
    u = flow[:, :, 0]
    v = flow[:, :, 1]
    magnitude = np.sqrt(u**2 + v**2)

    # Divergence (expansion/contraction)
    du_dx = np.gradient(u, axis=1)
    dv_dy = np.gradient(v, axis=0)
    divergence = du_dx + dv_dy

    # Curl (rotation)
    du_dy = np.gradient(u, axis=0)
    dv_dx = np.gradient(v, axis=1)
    curl = dv_dx - du_dy

    # Strain tensor components
    exx = du_dx
    eyy = dv_dy
    exy = 0.5 * (du_dy + dv_dx)

    print(f"Mean displacement: {magnitude.mean():.3f} px")
    print(f"Mean divergence: {divergence.mean():.6f}")
    print(f"Mean curl: {curl.mean():.6f}")

    return {
        'flow': flow, 'magnitude': magnitude,
        'divergence': divergence, 'curl': curl,
        'strain_xx': exx, 'strain_yy': eyy, 'strain_xy': exy
    }
```

### 7. Amyloid Plaque Quantification

Segment and measure amyloid plaques from fluorescence images.

```python
import numpy as np
import skimage.io
import skimage.filters
import skimage.measure
from skimage.morphology import remove_small_objects

def quantify_amyloid_plaques(image_path, min_plaque_area=50):
    """Quantify amyloid plaques from fluorescence microscopy.

    Args:
        image_path: path to fluorescence image (ThT/Congo Red staining)
        min_plaque_area: minimum plaque area in pixels
    """
    image = skimage.io.imread(image_path)
    if image.ndim == 3:
        image = image[:, :, 0]  # Take first channel

    # Preprocessing
    smoothed = skimage.filters.gaussian(image, sigma=2)

    # Threshold
    thresh = skimage.filters.threshold_otsu(smoothed)
    binary = smoothed > thresh

    # Remove small objects (noise)
    cleaned = remove_small_objects(binary, min_size=min_plaque_area)

    # Label and measure
    labels = skimage.measure.label(cleaned)
    regions = skimage.measure.regionprops(labels, intensity_image=image)

    # Extract measurements
    plaques = []
    for r in regions:
        plaques.append({
            'label': r.label,
            'area_px': r.area,
            'perimeter': r.perimeter,
            'eccentricity': r.eccentricity,
            'mean_intensity': r.mean_intensity,
            'max_intensity': r.max_intensity,
            'centroid_y': r.centroid[0],
            'centroid_x': r.centroid[1]
        })

    import pandas as pd
    df = pd.DataFrame(plaques)

    # Summary
    total_area = image.shape[0] * image.shape[1]
    plaque_area = df['area_px'].sum()
    plaque_density = len(df) / (total_area / 1e6)  # per million pixels

    print(f"Plaque count: {len(df)}")
    print(f"Total plaque area: {plaque_area} px ({100*plaque_area/total_area:.2f}%)")
    print(f"Mean plaque area: {df['area_px'].mean():.0f} px")
    print(f"Plaque density: {plaque_density:.1f} per Mpx")

    return df
```

## Typical Workflows

### Workflow 1: Compute ADC Map from Multi-b-Value Diffusion MRI

```python
adc_map, mask = compute_adc_map(
    dwi_paths=['b0.nii.gz', 'b500.nii.gz', 'b1000.nii.gz'],
    b_values=[0, 500, 1000]
)
stats = regional_adc_stats(adc_map, mask)
print(f"Mean ADC: {stats['mean']:.3f} x10⁻³ mm²/s")
```

### Workflow 2: Analyze Bone Microarchitecture from Micro-CT

```python
import tifffile
volume = tifffile.imread('microct_stack.tif')
results = bone_morphometry(volume, voxel_size_um=10)
print(f"BV/TV: {results['BV/TV']:.4f}")
print(f"Tb.Th: {results['Tb.Th (mm)']:.4f} mm")
```

### Workflow 3: Fit Circadian Rhythm Data with Cosinor Analysis

```python
import numpy as np
time = np.arange(0, 48, 2)  # Every 2 hours for 48 hours
activity = 100 + 40 * np.cos(2 * np.pi * time / 24 - 0.5) + np.random.normal(0, 10, len(time))

results = cosinor_analysis(time, activity)
print(f"Peak activity at: {results['acrophase_clock']}")
```

## Best Practices

1. **ADC maps** — use at least 2 non-zero b-values for reliable fitting; b=0 and b=1000 s/mm² is standard for brain
2. **Bone morphometry** — validate Otsu threshold against manual segmentation; report voxel size and scan parameters
3. **Cosinor analysis** — collect data spanning at least 2 full cycles; report MESOR, amplitude, acrophase, and p-value
4. **Ciliary beat** — recording must be at least 2x the expected CBF (Nyquist); typical CBF is 8-15 Hz requiring >30 fps
5. **Optical flow** — use Farneback for dense deformation fields, Lucas-Kanade for sparse tracking of features
6. **Always report units** — ADC in 10^-3 mm²/s, bone metrics in mm, blood pressure in mmHg, CBF in Hz

## Troubleshooting

**Problem:** ADC map has noisy regions
**Solution:** Apply Gaussian smoothing to DWI images before ADC calculation. Increase b-value range for better SNR. Mask out background using S0 threshold.

**Problem:** Bone segmentation includes soft tissue
**Solution:** Apply manual ROI selection before thresholding. Use adaptive thresholding for inhomogeneous CT values. Verify Hounsfield unit calibration.

**Problem:** Cosinor analysis not significant
**Solution:** Insufficient data points or too much noise. Collect more timepoints. Try different period values if 24h is not assumed. Check for ultradian rhythms.

**Problem:** CBF measurement gives wrong frequency
**Solution:** Verify recording fps is correct. Check ROI contains actively beating cilia. Increase recording duration for better frequency resolution.

## Resources

- [nibabel Documentation](https://nipy.org/nibabel/)
- [SimpleITK Documentation](https://simpleitk.readthedocs.io/)
- [Cosinor Analysis Method](https://doi.org/10.3109/07420528.2014.944728)
- [Bone Morphometry Standards (ASBMR)](https://doi.org/10.1002/jbmr.5650020107)
- [OpenCV Optical Flow Tutorial](https://docs.opencv.org/4.x/d4/dee/tutorial_optical_flow.html)
