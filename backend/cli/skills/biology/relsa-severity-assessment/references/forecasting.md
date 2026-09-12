# foRcast: ARIMA forecasting of RELSA trajectories

`scripts/forecast_relsa.py` ports the foRcast tool of Lutscher et al. (2026),
*Front. Physiol.* 17:1869563 — an ARIMA model fitted per animal to its own RELSA trajectory,
forecasting the score at the next time point (or at the humane endpoint) with a 95%
prediction interval.

The purpose is **triage, not automation**: identify the individuals at risk of reaching a
humane endpoint so handling personnel give them attention, while avoiding euthanising animals
that would have recovered. It is a proof of concept on 13 animals across seven models, not a
validated clinical tool.

## Why ARIMA

ARIMA(p, d, q) combines an autoregressive part (p lags of the series), differencing (d, to
remove trend and reach stationarity), and a moving-average part (q lags of the forecast
errors). It needs nothing but the animal's own history, which suits single-animal severity
assessment where each individual is its own control.

Model selection follows Hyndman & Khandakar (2008), i.e. `forecast::auto.arima`:

1. Choose `d` by successive KPSS tests (null = stationary; difference while it is rejected).
2. Fit four seed models — (2,d,2), (0,d,0), (1,d,0), (0,d,1) — with and without a
   constant/drift term.
3. Hill-climb from the best of those over neighbouring `(p, q)` and the drift term until AICc
   stops improving.

`auto_arima(..., stepwise=False)` searches the full `p × q` grid instead. Both are bounded by
`max_p`, `max_q`, `max_d`; the paper notes that the globally best model could lie outside that
range, which is a limitation of the approach rather than of one implementation.

## Interpolation: the necessary distortion

Animal experiments typically produce **one measurement per animal per day**. ARIMA is
conventionally said to want ~50 observations (Box et al., 2016), a number recently challenged
(Hassouna & Al-Sahili, 2020) but still far above what a 7-day study yields. The paper's
workaround is to interpolate linearly between observed values at 0.1-day increments and fit
the model to that denser series, and it is explicit that this is an alteration of the method,
not a free improvement:

- It **raises autocorrelation and partial autocorrelation**, which is what lets automatic
  order selection work at all on such short series.
- It **narrows the prediction interval**, improving coverage (PICP) at the cost of honestly
  representing uncertainty. The paper identifies interpolation as necessary "to minimize
  errors while maximizing prediction interval coverage with narrower boundaries".
- It adds no information. Interpolated points are a smoothness assumption, and a trajectory
  that actually moved non-linearly between measurements is misrepresented.

`interpolate_step=None` / `--interpolate-step 0` fits the observed series directly. Prefer it
whenever measurement frequency allows — with automated home-cage or telemetry monitoring the
interpolation step becomes unnecessary, which is the paper's own outlook.

## Forecast directly, not variable-by-variable

Two routes to a predicted RELSA score:

- **Direct** — forecast the RELSA series itself. `forecast_animal()`, `predict_endpoint()`.
- **Indirect** — forecast each outcome measure, then compute RELSA from the forecasts.
  `forecast_indirect()`.

The paper compared them in the sepsis model and direct won clearly: median deviation from the
actual score −0.002 (direct) versus −0.240 (indirect), a large effect
(d = 1.42, 95% CI [1.03, 1.81]). The reason is error propagation — each variable's forecast
error accumulates through the score, whereas the direct forecast carries only its own error.

Use direct. `forecast_indirect()` exists to reproduce the comparison and to inspect which
variable is driving a forecast.

## Metrics

Reported together, because each hides a failure the others catch
(`_common.forecast_metrics`):

| Metric | Meaning | Failure mode it exposes |
| --- | --- | --- |
| **RMSE** | root mean square deviation of predictions from actual RELSA scores | point-forecast accuracy |
| **PICP** | % of actual values falling inside the prediction interval | interval calibration |
| **MPIW** | mean prediction interval width, in RELSA units | a model that buys 100% PICP by making the interval useless |

MPIW is read against the RELSA scale, which normally spans about 0–1: the paper's overall
MPIW of 1.69 means the average interval covered 169% of the RELSA range, and the pancreatic
cancer model's 7.35 means 735% — a technically perfect PICP with almost no information in it.
Always report MPIW next to PICP.

## Published performance (Table 1)

Predicting the RELSA score at the (pre-)humane endpoint from all measurements up to the time
point immediately before it:

| Model / intervention | Animals | RMSE | PICP [%] | MPIW |
| --- | --- | --- | --- | --- |
| Sepsis | 2 | 0.009 | 100 | 0.30 |
| 1.5% DSS + restraint stress | 2 | 0.007 | 100 | 0.66 |
| 1% DSS + blood sampling | 4 | 0.046 | 75 | 0.53 |
| 1.5% DSS + blood sampling | 2 | 0.065 | 100 | 0.84 |
| 1.5% DSS | 1 | 0.095 | 100 | 1.64 |
| Pancreatic cancer | 1 | 0.177 | 100 | 7.35 |
| Neurosurgery | 1 | 0.082 | 100 | 0.54 |
| **Overall** | **13** | **0.069** | **96** | **1.69** |

Five of the seven rows rest on one or two animals. The overall PICP of 96% comes from 13
endpoint predictions.

## What this port reproduces

Using the public sepsis data (`tm_sepsis.txt`, 7 mice) with the paper's four telemetry
variables, no turned variables, and the CLP animals as reference set:

- Mouse ID_801 (the paper's Figure 1A): predicted RELSA 0.94 at the endpoint hour against an
  actual 0.93, RMSE 0.010, actual value inside the 95% interval. The published sepsis row is
  RMSE 0.009 over two animals.
- PICP 100% for both endpoint animals, matching the published row.
- MPIW 0.42–0.46 against a published 0.30 — this port's intervals are wider. The exact width
  depends on the interpolation step, the fitted variance, and the state-space implementation
  (statsmodels SARIMAX versus R's `arima`), so treat MPIW comparisons across
  implementations as approximate.

The paper's exact reference set and baseline window per model are in its Supplementary Table
S2, which is not bundled here; small differences in those choices shift every score slightly.

## Limits that matter more than the metrics

- **ARIMA cannot predict a cliff.** The model assumes stationarity and linearity. An abrupt
  collapse in the last hours before an endpoint is not forecastable from a smooth prior
  trajectory — this is the paper's own failure case (Figure 1C, the DSS blood-sampling mouse
  whose pre-endpoint score rose sharply and fell outside the 95% bounds). For sudden change,
  the paper points to Bayesian online changepoint detection (Adams & MacKay, 2007) or
  Markov switching models (Hamilton, 2020) as alternatives.
- **An underestimated score is the dangerous error.** An overestimate merely prompts extra
  attention; an underestimate discourages personnel from giving an animal the attention it
  needs and can delay a euthanasia decision. Asymmetric consequences deserve asymmetric
  handling: act on the *upper* bound of the interval.
- **RELSA is a severity-assessment aid, not a decision rule.** An animal with a low RELSA
  score that shows other signs of distress must still be handled accordingly. The paper is
  explicit that RELSA is "intended as an aid to severity assessment rather than a decisive
  parameter", and the RELSA package's own documentation states it is not a predictor of death.
- **Two prior measurements are not enough.** The paper's largest direct-prediction errors
  (Δ = 0.76 and 0.74) came from forecasts made at the earliest possible time point with only
  two prior observations. `forecast_animal()` records a warning below four observed points.
- **Parameter volatility hurts.** Activity forecast worst of the sepsis variables, being both
  intrinsically volatile and measured at low frequency. Including a noisy variable in the
  multivariate RELSA score mitigates its noise — one argument for the composite over
  single-parameter forecasting.

## Key references

- Hyndman, R. J. & Khandakar, Y. (2008). Automatic time series forecasting: the forecast
  package for R. *J. Stat. Softw.* 27, 1–22.
- Hyndman, R. J. & Athanasopoulos, G. (2021). *Forecasting: Principles and Practice*, 3rd ed.
- Khosravi, A. et al. (2011). Comprehensive review of neural network-based prediction
  intervals. *IEEE Trans. Neural Netw.* 22, 1341. (PICP/MPIW)
- Pang, J. et al. (2018). Optimize the coverage probability of prediction interval for anomaly
  detection of sensor-based monitoring series. *Sensors* 18, 967.
- Petrică, A. et al. (2016). Limitation of ARIMA models in financial and monetary economics.
  *Theor. Appl. Econ.* 23, 19–42.
