---
name: geoscience-data
description: Reads, transforms and summarizes gridded and geospatial data without losing the metadata that gives it meaning, covering NetCDF and HDF5 through xarray and netCDF4 with CF conventions, dimensions versus coordinates, time encodings and calendars and fill values, GeoTIFF and other rasters through rasterio and GDAL with nodata and resampling choices, coordinate reference systems and reprojection with pyproj and EPSG codes, geodesic versus planar distances and areas, vector data through geopandas, and unit handling with area weighting on latitude-longitude grids. Use for climate, weather, hydrology, remote sensing, land use and any map-based analysis; use the physics-fitting or spectral-analysis skills once the data is a clean array.
summary: "NetCDF, raster, CRS and vector handling with CF conventions and area weighting."
category: physics
allowed-tools: [Read, Bash, python]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Geoscience data

Gridded and geospatial data carry their meaning in metadata: units, fill values,
calendars, the coordinate reference system and the cell geometry. Most wrong answers come
from ignoring one of them, such as averaging over a latitude-longitude grid without
weights, treating `_FillValue` as zero, or mixing degrees with metres.

## NetCDF and HDF5

1. `xr.open_dataset(path)` decodes CF metadata: `scale_factor` and `add_offset` unpack
   integers, `_FillValue` and `missing_value` become NaN, and time is decoded from
   `units` ("days since 1850-01-01") with the `calendar` attribute. Use
   `decode_times=False` to see raw numbers, `use_cftime=True` for `noleap` or `360_day`
   calendars and for dates outside the range of nanosecond `datetime64`. Multi-file:
   `xr.open_mfdataset(pattern, combine="by_coords", chunks={...})` with dask. Inspect
   with `ncdump -h` or `ds.info()`, and read `units`, `standard_name`, `cell_methods` and
   `bounds` for every variable you use. HDF5 that is not NetCDF-4 opens with `h5py`.
2. Dimensions are axes (`time`, `lat`, `lon`); coordinates are labels on them. On a
   curvilinear grid `lat(y, x)` is a two-dimensional coordinate and `sel` by latitude no
   longer works directly. Longitude runs 0 to 360 in many models and -180 to 180 in
   others; convert with `ds.assign_coords(lon=((ds.lon + 180) % 360) - 180).sortby("lon")`.
   Latitude often descends from 90 to -90, so `sel(lat=slice(a, b))` needs that order.
3. Time stamps of monthly means may mark the start, middle or end of the month; consult
   `time_bnds`. Yearly means from monthly means must weight by
   `ds.time.dt.days_in_month`. `ds.resample(time="1MS").mean()` for calendar months.
   Times are UTC unless the file says otherwise.
4. Writing: `ds.to_netcdf(path, encoding=enc)` with a per-variable `enc` such as
   `{"var": {"dtype": "float32", "_FillValue": -9999.0, "zlib": True, "complevel": 4}}`;
   keep `units` and `standard_name` attributes on every variable, and never let a fill
   value coincide with a valid data value.

## Area weighting and regridding

5. On a regular latitude-longitude grid cell area scales with cos(latitude):
   `w = np.cos(np.deg2rad(ds.lat)); ds.weighted(w).mean(("lat", "lon"))`. Prefer an
   explicit `cell_area` variable or areas computed from `lat_bnds` when present.
   Unweighted means over-represent the poles. Totals (mass, volume, emissions) need
   true areas in square metres and a stated Earth radius (6371 km) or ellipsoid.
6. Regridding: conservative for fluxes and extensive quantities, bilinear for smooth
   intensive fields, nearest for categorical data (xesmf implements all three;
   `xr.interp` is bilinear). Name the method and the target grid.

## Raster

7. `rasterio.open(path)` exposes `crs`, `transform` (affine pixel-to-world),
   `nodata`, `res`, `bounds` and `tags()`. `src.read(1, masked=True)` honours nodata.
   GeoTIFF `AREA_OR_POINT` says whether a pixel value describes the cell or its centre.
   Reproject with `rasterio.warp.calculate_default_transform` and
   `reproject(..., resampling=Resampling.bilinear)`; `Resampling.nearest` for classes,
   `average` or `sum` when coarsening. GDAL equivalents: `gdalinfo -stats`,
   `gdalwarp -t_srs EPSG:3035 -tr 100 100 -r bilinear -dstnodata -9999 in.tif out.tif`,
   `gdal_translate -of COG`. `rioxarray.open_rasterio(path)` gives an xarray with
   `.rio.crs`, `.rio.reproject("EPSG:...")` and `.rio.write_nodata(...)`.

## Coordinate reference systems

8. EPSG:4326 is WGS 84 latitude-longitude in degrees; its authority axis order is
   latitude first while most software expects longitude first, so create transformers
   with `pyproj.Transformer.from_crs(4326, 3857, always_xy=True)`. EPSG:3857 (Web
   Mercator) distorts area and is for tiles, not measurement. UTM zones are EPSG:326xx
   north and 327xx south; equal-area choices include EPSG:3035 (Europe LAEA), EPSG:5070
   (CONUS Albers) and EPSG:6933 (global EASE-Grid 2.0). `pyproj.CRS.from_epsg(code)`
   exposes `axis_info`, `is_geographic` and units.
9. Distances and areas on geographic coordinates are computed geodesically, not in
   degrees: `pyproj.Geod(ellps="WGS84").inv(lon1, lat1, lon2, lat2)` returns metres, and
   `geod.geometry_area_perimeter(polygon)` returns square metres. Haversine is spherical
   and off by up to half a percent; say which formula was used. Datum shifts (WGS 84,
   NAD83, ETRS89) matter at the metre level; elevation needs a stated vertical datum.

## Vector

10. `geopandas.read_file(path)` for shapefile, GeoPackage and GeoJSON; `gdf.crs`,
    `gdf.to_crs(epsg=...)`, `gdf.estimate_utm_crs()` for a local metric CRS, then `.area`
    and `.length` in that CRS's units (geographic CRS results are warned about and wrong).
    `sjoin(predicate="intersects")`, `overlay`, `dissolve`; validate with `is_valid` and
    `make_valid`. Shapefiles limit field names to 10 characters, files to 2 GB, one
    geometry type per layer and need `.shp`, `.shx`, `.dbf` and `.prj` together; prefer
    GeoPackage. Buffers in degrees are meaningless; buffer in a projected CRS.

## Units and reporting

- Convert explicitly (K to degrees Celsius, kg m^-2 s^-1 to mm/day by 86400, Pa to hPa) or
  with `pint` and `cf_xarray`; put units in every column header.
- State CRS (EPSG), resolution, resampling, weighting, calendar, fill handling, and the
  provenance of each file (URL, version, download date).

## Sources

- CF Metadata Conventions: https://cfconventions.org/
- xarray user guide (I/O, weighted reductions, time series): https://docs.xarray.dev/en/stable/user-guide/
- netCDF4-python: https://unidata.github.io/netcdf4-python/
- rasterio reprojection: https://rasterio.readthedocs.io/en/stable/topics/reproject.html
- GDAL `gdalwarp`: https://gdal.org/en/stable/programs/gdalwarp.html
- pyproj `Transformer` and `Geod`: https://pyproj4.github.io/pyproj/stable/api/
- GeoPandas projections guide: https://geopandas.org/en/stable/docs/user_guide/projections.html
- EPSG Geodetic Parameter Registry: https://epsg.org/
