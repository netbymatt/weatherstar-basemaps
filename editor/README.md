# Marker editor

Visual tool for positioning the markers that go on the map: station labels,
interstate shields, and the seed points for filled areas.

```
npm run editor     # http://localhost:8080/editor/
```

It overlays `reference-images/radar.webp` (the legacy basemap) with a rendered
map from `output/`, so run the pipeline at least once first. The **Generated
map** picker under Base layer chooses which one.

## How placement works

Every station, road icon and fill point is stored as a `lat`/`lon` and placed by
running it through the region's projection:

| file | shape |
| --- | --- |
| `stations.json` | `{ "ABE": { "lat": ..., "lon": ... } }` |
| `road-icons.json` | `[ { "lat": ..., "lon": ... } ]` |
| `fills.json` | `[ { "lat": ..., "lon": ..., "color": ..., "maps": [...] } ]` |

Markers used to carry `x`/`y` pixel coordinates from the legacy basemap, with an
approximate polynomial fit converting them for entries that had no coordinates
of their own. That is all gone — the `x`/`y` columns were dropped once every
entry had real coordinates.

## Working with it

Click a marker to select it, click empty map to move it there. Old position is
covered in red, new position drawn in green. Edits are kept in `localStorage`
and committed when you select another marker or press <kbd>S</kbd>. Press
<kbd>?</kbd> for the full shortcut list.

### Lining the two maps up

The reference and the generated map are in different projections, so they never
line up everywhere at once. **Reference offset** shifts the reference image by
whole pixels — type into the fields, or hold <kbd>Alt</kbd> and use the arrow
keys (<kbd>Shift</kbd> for 10px steps). The offset is remembered between
sessions and shown in the status bar.

It moves the reference image only. Marker positions and the exported files are
untouched, so you can shift it freely to compare a region without affecting any
correction.

Layer keys worth knowing: <kbd>B</kbd> or <kbd>Tab</kbd> flips between the two
maps, holding <kbd>Space</kbd> peeks at the one underneath, and
<kbd>[</kbd>/<kbd>]</kbd> blends the top layer.

The export buttons download `road-icons.json`, `stations.json` and `fills.json`;
drop them into `data/` and re-render. An export with no corrections reproduces
the files unchanged, so corrections are the only meaningful lines in the diff.

## Fill mode

Some land has no state or county polygon over it, so on the forecast map Canada,
Mexico, the Caribbean and Vancouver Island are drawn as bare coastline over
water. Fill mode marks points where one of those areas should be filled in.

Press <kbd>M</kbd> or use the Mode switch. Clicking empty map adds a point;
clicking a crosshair selects it. Each point records a lat/lon, a color named
from the maps' `COLORS`, and which maps it applies to:

```json
[
	{"lat": 30.1, "lon": -115.4, "color": "extraFill", "maps": ["radar", "forecast"]}
]
```

`color` is a key from the map's `COLORS`, so the same point can resolve to a
different shade on each map it applies to. A point listing no `maps` applies to
all of them.

At render time the `fill` section runs a **flood fill** from each point: it
samples the color under that pixel and spreads across everything matching it,
stopping wherever something is already drawn. So a point dropped inside an
unfilled landmass floods that landmass and halts at its coastline.

The editor does not preview the result - a point is just a green crosshair
marking where the fill starts. Re-render to see the effect.

Each area needs its own point, since a flood only spreads through connected
pixels: one for mainland Canada, one per island. If a fill leaks somewhere it
should not, the boundary it escaped through has a gap; give that point a lower
`"tolerance"` (the default is 32, a distance in RGBA space) or move it.

Switch the **Generated map** picker to `forecast` while doing this — that is the
map the fills exist for.

## Verifying

```
npm run editor:verify      # browser math matches the pipeline; exports round trip
npm run editor:verify-ui   # drives the page in headless chrome (needs npm run editor)
```

`projection.mjs` reimplements `src/createProjection.mjs` so the browser doesn't
need proj4. Re-run `editor:verify` after touching either side — it fails if the
two drift apart.
