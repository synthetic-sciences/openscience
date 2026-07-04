---
name: spectral-analysis
description: Frequency-domain analysis — FFT, power spectral density (Welch/periodogram), spectrograms, wavelet transforms, and coherence. Use for any signal with periodic, quasi-periodic, or transient frequency content in physics data.
category: physics
version: 1.0.0
author: Synthetic Sciences
license: MIT
tags: [FFT, Spectral Analysis, PSD, Wavelets, Signal Processing, Frequency, Physics]
dependencies: ["scipy>=1.11.0", "numpy>=1.24.0", "matplotlib>=3.7.0"]
---

# Spectral Analysis

## Overview

Extract frequency content from physics signals using FFT, power spectral density estimation, spectrograms, and wavelet transforms. Covers stationary and non-stationary signals.

## When to Use

- Finding oscillation frequencies in time-series data
- Computing power spectra of turbulence, vibrations, or wave data
- Detecting transient features (spectrograms, wavelets)
- Filtering signals (low-pass, band-pass, notch)
- Cross-spectral analysis and coherence between signals

## Core Workflows

### 1. FFT (Fast Fourier Transform)

```python
import numpy as np
import matplotlib.pyplot as plt

# Signal: sum of two sinusoids + noise
dt = 0.001  # sampling interval [s]
fs = 1 / dt  # sampling frequency [Hz]
t = np.arange(0, 1, dt)
signal = 1.5 * np.sin(2*np.pi*50*t) + 0.8 * np.sin(2*np.pi*120*t)
signal += 0.5 * np.random.randn(len(t))

# Compute FFT
N = len(t)
fft_vals = np.fft.rfft(signal)
freqs = np.fft.rfftfreq(N, d=dt)
amplitude = 2.0 / N * np.abs(fft_vals)  # single-sided amplitude
phase = np.angle(fft_vals)

fig, axes = plt.subplots(2, 1, figsize=(10, 7))
axes[0].plot(t[:200], signal[:200], 'b-', linewidth=0.8)
axes[0].set_xlabel('Time [s]')
axes[0].set_ylabel('Amplitude')
axes[0].set_title('Time Domain Signal')
axes[0].grid(True, alpha=0.3)

axes[1].plot(freqs, amplitude, 'r-', linewidth=0.8)
axes[1].set_xlabel('Frequency [Hz]')
axes[1].set_ylabel('Amplitude')
axes[1].set_title('FFT Amplitude Spectrum')
axes[1].set_xlim(0, 200)
axes[1].grid(True, alpha=0.3)

plt.tight_layout()
plt.savefig('fft_analysis.png', dpi=150, bbox_inches='tight')
```

### 2. Power Spectral Density (Welch Method)

```python
from scipy.signal import welch, periodogram

# Welch PSD (better noise averaging than raw FFT)
freqs_w, psd_w = welch(signal, fs=fs, nperseg=256, noverlap=128)

# Periodogram (raw, no averaging)
freqs_p, psd_p = periodogram(signal, fs=fs)

fig, ax = plt.subplots(figsize=(10, 5))
ax.semilogy(freqs_p, psd_p, 'gray', alpha=0.3, label='Periodogram')
ax.semilogy(freqs_w, psd_w, 'r-', linewidth=2, label='Welch PSD')
ax.set_xlabel('Frequency [Hz]')
ax.set_ylabel('PSD [V²/Hz]')
ax.set_title('Power Spectral Density')
ax.legend()
ax.grid(True, alpha=0.3)
ax.set_xlim(0, 200)
plt.savefig('psd.png', dpi=150, bbox_inches='tight')
```

**Welch parameters:**
- `nperseg`: Segment length (frequency resolution = fs/nperseg)
- `noverlap`: Overlap between segments (typically 50% = nperseg//2)
- `window`: Window function ('hann' default, 'blackman' for better sidelobe suppression)
- Trade-off: longer segments → better frequency resolution, worse noise averaging

### 3. Spectrogram (Time-Frequency)

```python
from scipy.signal import spectrogram

# Chirp signal (frequency sweeps from 10 to 200 Hz)
t_chirp = np.linspace(0, 2, 8000)
chirp = np.sin(2*np.pi * (10*t_chirp + 47.5*t_chirp**2))

f_spec, t_spec, Sxx = spectrogram(chirp, fs=4000, nperseg=256, noverlap=200)

fig, ax = plt.subplots(figsize=(10, 5))
pcm = ax.pcolormesh(t_spec, f_spec, 10*np.log10(Sxx + 1e-20),
                     shading='gouraud', cmap='inferno')
ax.set_ylabel('Frequency [Hz]')
ax.set_xlabel('Time [s]')
ax.set_title('Spectrogram')
plt.colorbar(pcm, ax=ax, label='PSD [dB/Hz]')
plt.savefig('spectrogram.png', dpi=150, bbox_inches='tight')
```

### 4. Wavelet Transform (Continuous)

```python
from scipy.signal import cwt, morlet2

# Continuous wavelet transform with Morlet wavelet
widths = np.geomspace(1, 128, num=100)  # scale parameters
cwtmatr = cwt(signal, morlet2, widths, w=6)

# Convert scales to frequencies: f = w * fs / (2*pi*scale)
frequencies = 6 * fs / (2 * np.pi * widths)

fig, ax = plt.subplots(figsize=(10, 5))
ax.pcolormesh(t, frequencies, np.abs(cwtmatr),
              shading='gouraud', cmap='viridis')
ax.set_ylabel('Frequency [Hz]')
ax.set_xlabel('Time [s]')
ax.set_title('Continuous Wavelet Transform (Morlet)')
ax.set_ylim(0, 200)
plt.colorbar(ax.collections[0], ax=ax, label='|CWT|')
plt.savefig('cwt.png', dpi=150, bbox_inches='tight')
```

### 5. Cross-Spectral Analysis and Coherence

```python
from scipy.signal import coherence, csd

# Two related signals
signal2 = 1.2 * np.sin(2*np.pi*50*t + 0.3) + 0.6 * np.random.randn(len(t))

# Coherence (how correlated are the two signals at each frequency)
f_coh, Cxy = coherence(signal, signal2, fs=fs, nperseg=256)

# Cross-spectral density
f_csd, Pxy = csd(signal, signal2, fs=fs, nperseg=256)

fig, axes = plt.subplots(2, 1, figsize=(10, 7))
axes[0].plot(f_coh, Cxy, 'b-', linewidth=1.5)
axes[0].set_ylabel('Coherence')
axes[0].set_title('Coherence between signals')
axes[0].set_xlim(0, 200)
axes[0].grid(True, alpha=0.3)

axes[1].semilogy(f_csd, np.abs(Pxy), 'r-', linewidth=1.5)
axes[1].set_xlabel('Frequency [Hz]')
axes[1].set_ylabel('|CSD| [V²/Hz]')
axes[1].set_title('Cross-Spectral Density')
axes[1].set_xlim(0, 200)
axes[1].grid(True, alpha=0.3)
plt.tight_layout()
plt.savefig('coherence.png', dpi=150, bbox_inches='tight')
```

### 6. Filtering

```python
from scipy.signal import butter, sosfilt, sosfiltfilt

def bandpass_filter(data, lowcut, highcut, fs, order=4):
    """Apply zero-phase Butterworth bandpass filter."""
    nyq = 0.5 * fs
    sos = butter(order, [lowcut/nyq, highcut/nyq], btype='band', output='sos')
    return sosfiltfilt(sos, data)

# Example: extract 45-55 Hz component
filtered = bandpass_filter(signal, 45, 55, fs, order=4)
```

## Frequency Resolution vs Averaging Trade-off

| Parameter | Effect on Resolution | Effect on Noise |
|---|---|---|
| Longer `nperseg` | Better frequency resolution | More noise (fewer averages) |
| Shorter `nperseg` | Worse frequency resolution | Less noise (more averages) |
| More `noverlap` | Same resolution | Slightly less noise |
| Windowing (Hann) | Wider main lobe | Better sidelobe suppression |

**Rule of thumb:** Frequency resolution Δf = fs / nperseg

## Common Pitfalls

| Pitfall | Fix |
|---|---|
| Aliasing (fs too low) | Nyquist: fs ≥ 2 × f_max |
| Spectral leakage | Apply window function (Hann, Blackman) |
| Zero-padding confusion | Zero-padding interpolates FFT, doesn't improve resolution |
| Wrong units on PSD | Check: V²/Hz for continuous, V² for discrete |
| DC component dominates | Subtract mean before FFT |
| Non-uniform sampling | Use Lomb-Scargle periodogram (`scipy.signal.lombscargle`) |
