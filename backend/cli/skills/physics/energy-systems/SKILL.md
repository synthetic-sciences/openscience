---
name: energy-systems
description: Applies energy-systems modelling conventions so that capacity, energy, cost and emissions numbers are consistent and comparable, covering kW versus kWh and MW versus MWh, capacity versus energy, capacity factors, load duration curves, the LCOE formula with discounting and capital recovery factors, dispatch and capacity-expansion modelling with PyPSA and pyomo, time-series alignment across time zones and interval conventions, emissions factors by scope, and the assumptions table every result needs. Use for power-system, generation cost, storage, grid-mix or decarbonization analyses; use statistical-conventions for the statistics and geoscience-data for weather and resource rasters.
summary: "Energy units, capacity factors, LCOE, dispatch modelling and time-zone conventions."
category: physics
allowed-tools: [Read, Bash, python]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Energy systems modelling

Energy analysis fails on units and time before it fails on optimization: power confused
with energy, local time with UTC, period-start with period-end stamps, gross with net.
Write the conventions down before computing, and print them with the result.

## Units and definitions

1. Power is a rate (kW, MW, GW); energy is a quantity (kWh, MWh, GWh, also GJ and TWh),
   energy = power x time. A 100 MW plant delivers at most 100 MWh per hour; annual output
   is 100 MW x 8760 h x capacity factor. Never add MW to MWh. Conversions: 1 MWh =
   3.6 GJ; 1 MMBtu = 1.055056 GJ; 1 toe = 41.868 GJ; 1 kWh = 3412.14 Btu. Heat rate in
   Btu/kWh equals 3412.14 divided by efficiency. Distinguish MWe from MWth, PV MWdc from
   MWac (inverter loading ratio), nameplate from net capacity (auxiliary loads).
2. Capacity factor = energy delivered in a period / (nameplate x hours in the period).
   State the period (8760 h, 8784 in leap years), the capacity basis (AC or DC, net or
   gross) and whether outages are included.
3. Load duration curve: sort hourly load descending and plot against hours or fraction of
   the year; the maximum is peak, the minimum is baseload, the area is energy. The
   residual load duration curve (load minus variable renewables) can go negative and its
   negative area is a curtailment upper bound.

## Economics

4. LCOE = sum over t of (I_t + M_t + F_t) / (1 + r)^t divided by sum over t of E_t /
   (1 + r)^t, both over the same lifetime n, with the energy term discounted as well.
   With the capital recovery factor CRF = r (1 + r)^n / ((1 + r)^n - 1), the annualized
   form is LCOE = (CAPEX x CRF + fixed O&M) / (8760 x CF) + variable O&M + fuel price /
   efficiency. State r (real or nominal, matched to the cost basis), n, currency and
   price year, degradation, and tax or subsidy treatment. LCOE ignores when energy is
   delivered and how firm it is; do not rank dispatchable and variable sources by LCOE
   alone.
5. Emissions factors: tCO2/MWh, or gCO2/kWh (1 tCO2/MWh = 1000 gCO2/kWh). Direct
   combustion factors (IPCC 2006 defaults in kg CO2 per TJ of fuel, converted through
   heat rate) differ from lifecycle factors; grid average differs from marginal;
   location-based differs from market-based (GHG Protocol Scope 2). Give the factor's
   source, year and scope, and say CO2 or CO2e (methane and N2O with GWP100).

## Time series

6. Record the time zone and whether a stamp marks the start or the end of its interval;
   ENTSO-E and many system operators publish period-start UTC, others local period-end.
   Local time has 23-hour and 25-hour days at daylight-saving transitions, so localize
   with `tz_localize("Europe/Berlin", ambiguous="infer", nonexistent="shift_forward")`,
   then `tz_convert("UTC")`, and build model indices in UTC with
   `pd.date_range("2023-01-01", periods=8760, freq="h", tz="UTC")`.
7. Resampling: `.resample("h").mean()` for power in MW, `.sum()` for energy in MWh with
   the interval scaling made explicit (a 15-minute MW value contributes MW / 4 MWh).
   Align weather year and demand year, handle leap days deliberately, and never fill a
   missing hour with zero: a zero is data, a gap is not. Interpolate only short gaps and
   log them.

## Modelling

8. PyPSA capacity expansion in a few lines: `n = pypsa.Network()`,
   `n.set_snapshots(index)`, `n.add("Bus", "b")`, a `Load` with `p_set=demand`, and a
   `Generator` with `p_nom_extendable=True`, `p_max_pu=cf_series`,
   `capital_cost=eur_per_mw_year`, `marginal_cost=eur_per_mwh` and `carrier="wind"`;
   storage with `StorageUnit` or `Store`; then `n.optimize(solver_name="highs")`.
   Results: `n.generators.p_nom_opt`,
   `n.generators_t.p`, `n.buses_t.marginal_price`, `n.objective`. `capital_cost` is
   annualized per MW per year, so `n.snapshot_weightings` must sum to the hours of one
   year when snapshots are sampled. Emission caps use a `GlobalConstraint` on the
   `co2_emissions` carrier attribute. Run `n.consistency_check()` first.
9. pyomo for custom formulations: `ConcreteModel`, `Var(..., within=NonNegativeReals)`,
   `Constraint`, `Objective(sense=minimize)`, `SolverFactory("appsi_highs")` (or `cbc`,
   `gurobi`), then confirm
   `results.solver.termination_condition == TerminationCondition.optimal` before reading
   values; duals via `model.dual = Suffix(direction=Suffix.IMPORT)`. Merit-order dispatch
   sorts by marginal cost; unit commitment needs binaries and solves far slower.
10. Check the balance after every solve: supply = demand + losses + curtailment within
    0.1%, storage state of charge closes over the horizon, no generator exceeds
    `p_nom x p_max_pu`. A feasible solve with an unexplained slack is a modelling error.

## Reporting

- Assumptions table: costs and lifetimes, r, efficiencies, capacity-factor sources,
  emission factors with scope, weather year, demand year, time zone, resolution.
- Objective value, installed capacity and energy by carrier, curtailment, price duration
  curve, emissions; sensitivity to r and fuel prices; units on every number.

## Sources

- NREL Annual Technology Baseline, definitions (LCOE, CRF, capacity factor): https://atb.nrel.gov/electricity/2024/definitions
- IEA and NEA, Projected Costs of Generating Electricity 2020 (LCOE methodology): https://www.iea.org/reports/projected-costs-of-generating-electricity-2020
- IPCC 2006 Guidelines, Volume 2 Energy (default emission factors): https://www.ipcc-nggip.iges.or.jp/public/2006gl/vol2.html
- GHG Protocol Scope 2 Guidance: https://ghgprotocol.org/scope-2-guidance
- PyPSA documentation: https://pypsa.readthedocs.io/
- Pyomo documentation: https://pyomo.readthedocs.io/
- pandas time zone handling: https://pandas.pydata.org/docs/user_guide/timeseries.html#time-zone-handling
- ENTSO-E Transparency Platform: https://transparency.entsoe.eu/
