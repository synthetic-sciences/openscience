---
name: astronomy-inference
description: Carries astronomical data from file to posterior with the conventions the field expects, covering astropy units, coordinates, FITS, WCS and Time with barycentric corrections, photometric systems and magnitude arithmetic, period finding with the astropy Lomb-Scargle periodogram and its false-alarm levels, Bayesian parameter estimation with emcee and nested sampling with dynesty, convergence diagnostics such as autocorrelation time and R-hat, uncertainty propagation through samples, and explicit reporting of priors. Use for light curves, photometry, spectroscopy, orbit or transit fits and any astronomical parameter estimation; use astropy for plain library usage and bayesian-inference for non-astronomical models.
summary: "astropy conventions, magnitudes, Lomb-Scargle, MCMC and nested sampling diagnostics."
category: physics
allowed-tools: [Read, Bash, python]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Astronomy inference

Astronomy overloads its conventions: magnitudes are logarithmic and zero-point dependent,
times have scales as well as formats, coordinates have frames and epochs, and a periodogram
peak is a candidate rather than a detection. Fix the conventions first, then infer, then
report the priors and diagnostics alongside the posterior.

## astropy foundations

1. Attach units at input and keep them until the final print: `astropy.units` Quantities
   with `.to(u.Jy)`, spectral conversions via `equivalencies=u.spectral()` and flux
   density conversions via `u.spectral_density(wavelength)`; constants from
   `astropy.constants`. Stripping units early is how a factor of 1e-23 disappears.
2. Coordinates: `SkyCoord(ra, dec, unit="deg", frame="icrs")`; ICRS, FK5 (J2000) and
   Galactic are different frames. Angular separation is `c1.separation(c2)`, never a
   Pythagorean difference in RA and Dec (RA shrinks by cos Dec). Cross-match with
   `match_to_catalog_sky` and report the match radius. High proper-motion targets need
   `obstime` and `apply_space_motion` to the observation epoch.
3. Time: `Time("2023-01-01T00:00:00", format="isot", scale="utc")`; scales UTC, TAI, TT
   and TDB differ by tens of seconds, formats `jd`, `mjd`, `isot` are only
   representations (MJD = JD - 2400000.5). Timing work uses BJD_TDB:
   `ltt = t.light_travel_time(coord, kind="barycentric", location=site)` then
   `(t.tdb + ltt).jd`. Heliocentric JD differs from barycentric by several seconds; UTC
   differs from TDB by more than a minute. State the scale and reference frame of every
   time column.
4. FITS: `with fits.open(path) as hdul: hdul.info()`, then `hdul[i].header` and
   `hdul[i].data`; read `BUNIT`, `BSCALE`, `BZERO`, `EXPTIME`, `MJD-OBS`. Tables load with
   `astropy.table.Table.read(path, hdu=1)`. FITS data are big-endian; convert before
   handing arrays to libraries that assume native order. WCS: `w = WCS(header)`,
   `w.pixel_to_world(x, y)` and `w.world_to_pixel(coord)` use zero-based pixels, while
   FITS headers are one-based (`origin` argument in `wcs_pix2world`). Pixel scale via
   `astropy.wcs.utils.proj_plane_pixel_scales(w)`.

## Photometry

5. Magnitudes are m = -2.5 log10(F / F0) and the zero point F0 defines the system: AB
   uses 3631 Jy (`flux.to(u.ABmag)` for a spectral flux density), Vega uses the spectrum
   of Vega per filter (offsets from AB range from about 0 in V to about 1.85 in Ks), ST
   uses a flat F_lambda (`u.STmag`). Mixing systems is a 0.1 to 2 magnitude error.
   Average fluxes, not magnitudes; convert errors with sigma_m = 1.0857 sigma_F / F.
   Distance modulus mu = m - M = 5 log10(d / 10 pc). Report system, filter, zero point,
   airmass and extinction corrections, and aperture.
6. Period finding: `ls = astropy.timeseries.LombScargle(t, y, dy)` then
   `freq, power = ls.autopower(samples_per_peak=10)` with `minimum_frequency` and
   `maximum_frequency` chosen from the cadence and baseline; the grid must resolve peak
   widths of order 1 / baseline, so oversample. Significance via
   `ls.false_alarm_probability(power.max(), method="baluev")` or `method="bootstrap"`;
   then check aliases (1 cycle per day for ground-based data, harmonics at P/2 and 2P),
   phase-fold at the candidate period and overlay `ls.model(t_fit, best_frequency)`.
   Period uncertainty comes from the peak width or a bootstrap, not from the grid
   spacing. `BoxLeastSquares` is the transit analogue.

## Bayesian inference

7. Write down the likelihood (Gaussian with per-point sigma, plus a jitter term `ln s`
   when residuals exceed the errors), the prior for every parameter with bounds and shape
   (uniform versus log-uniform for scale parameters), and the parameterization (sample
   `sqrt(e) cos w, sqrt(e) sin w` rather than `e, w`). These go in the report verbatim.
8. emcee: `sampler = emcee.EnsembleSampler(nwalkers, ndim, log_prob, args=(x, y, yerr))`,
   `sampler.run_mcmc(p0, nsteps, progress=True)`, then
   `tau = sampler.get_autocorr_time(tol=0)`. A chain is usable when its length exceeds
   about 50 tau for every parameter (emcee's default `tol=50` enforces this); discard a
   burn-in of a few tau and thin by about tau / 2 with
   `sampler.get_chain(discard=..., thin=..., flat=True)`. Check
   `sampler.acceptance_fraction` (roughly 0.2 to 0.5). Walkers in one ensemble are not
   independent chains, so R-hat needs several independent runs; compute it with
   `arviz.rhat` and effective sample size with `arviz.ess`. Report tau, N / tau and R-hat.
9. dynesty: `sampler = dynesty.NestedSampler(loglike, prior_transform, ndim, nlive=500)`,
   `sampler.run_nested(dlogz=0.01, checkpoint_file="run.save")`, `res = sampler.results`;
   evidence `res.logz[-1]` with `res.logzerr[-1]`, equal-weight posterior draws from
   `res.samples_equal()` (or `dynesty.utils.resample_equal` applied to `res.samples`
   and `res.importance_weights()`). `DynamicNestedSampler` when the posterior matters
   more than the evidence. Evidences depend on prior volumes, so a Bayes factor is
   reported with both priors.
10. Summaries: median with 16th and 84th percentiles per parameter, a corner plot,
    posterior predictive curves over the data, and derived quantities computed from the
    samples rather than from point estimates. For simple propagation use
    `astropy.uncertainty.Distribution` or sample arithmetic; state correlations.

## Report

- Data: source, filter or instrument, N points, time scale and reference, quality cuts.
- Model, parameterization, prior table, sampler settings (walkers, steps, nlive, seed).
- Diagnostics: tau per parameter, N / tau, acceptance fraction, R-hat, dlogz reached.
- Parameter table with credible intervals, evidence if computed, and known systematics.

## Sources

- astropy documentation (units, coordinates, time, FITS, WCS): https://docs.astropy.org/en/stable/
- astropy Lomb-Scargle periodograms: https://docs.astropy.org/en/stable/timeseries/lombscargle.html
- emcee autocorrelation analysis and convergence: https://emcee.readthedocs.io/en/stable/tutorials/autocorr/
- dynesty documentation: https://dynesty.readthedocs.io/en/stable/
- ArviZ diagnostics (`rhat`, `ess`): https://python.arviz.org/en/stable/api/diagnostics.html
- VanderPlas (2018), Understanding the Lomb-Scargle periodogram, ApJS 236, 16: https://doi.org/10.3847/1538-4365/aab766
- Eastman, Siverd and Gaudi (2010), Achieving better than 1 minute accuracy in the HJD and BJD, PASP 122, 935: https://doi.org/10.1086/655938
- Hogg and Foreman-Mackey (2018), Data analysis recipes, using MCMC, ApJS 236, 11: https://doi.org/10.3847/1538-4365/aab76e
