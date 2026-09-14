# basic-map

Renders WeatherStar-style basemaps of the continental US from OpenStreetMap and
public shapefile data.

Each map is drawn to a canvas one layer at a time — land, counties, lakes,
states, roads, interstate shields, station labels — then reduced to a fixed
palette and sliced into tiles.

## Requirements

- Node 24 or newer
- A toolchain for [`node-canvas`](https://github.com/Automattic/node-canvas#compiling)
  and [`sharp`](https://sharp.pixelplumbing.com/install), both of which build
  native code

```sh
npm install
```

## Rendering

```sh
node src/index.mjs
```

Every region in [`src/REGIONS.mjs`](src/REGIONS.mjs) is rendered against every
map in [`src/MAPS.mjs`](src/MAPS.mjs), producing:

| path | what it is |
| --- | --- |
| `output/{map}-{region}.png` | the finished map |
| `output/{map}-{region}.webp` | the same, lossless webp |
| `output/tiles/{map}-{region}/{xx}-{yy}.webp` | 510×320 lossless webp tiles, `00-00` at the northwest corner |
| `output/raw/{map}-{region}-{n}.png` | one snapshot per section, for debugging |

The source data is committed, so a fresh clone renders without fetching
anything.

## Configuration

A **region** is a bounding box and an output size:

```js
{
  NAME: 'conus',
  bounds: { x: [-126, -65.5], y: [50.5, 23.5] },  // lon, lat
  outputSize: { width: 5100, height: 3200 },
}
```

A **map** is a palette plus the list of steps to run. `SECTIONS` are drawn in
order onto the canvas; `POST` runs afterwards on the finished image:

```js
{
  NAME: 'forecast',
  COLORS: { state: '#000000', stateFill: '#7f7f7f', water: '#4b69aa', ... },
  SECTIONS: ['land', 'fill', 'state'],
  POST: ['palettize'],
}
```

| section | draws |
| --- | --- |
| `land`, `lakes`, `state`, `county` | shapefile outlines and fills |
| `road` | interstates from OpenStreetMap |
| `fill` | flood fills the areas marked in `data/fills.json` |
| `road-icons` | interstate shields |
| `stations` | station labels |

| post step | does |
| --- | --- |
| `palettize` | reduces to a fixed palette built from `COLORS`, writes the png/webp |
| `pixelate` | re-renders at `PIXELATE_SCALE` and blows it back up, writing a `-pixelated` pair |
| `tiles` | slices the webp into 510×320 tiles |

Anything left out of `SECTIONS` or `POST` simply doesn't run, so a map only
pays for what it draws.

## Marker data

Stations, interstate shields and fill seeds all live in `data/` as plain
lat/lon, placed through the region's projection at render time:

```jsonc
// data/stations.json
{ "PIH": { "lat": 42.92028, "lon": -112.57111 } }

// data/road-icons.json
[ { "lat": 48.60293, "lon": -97.19499 } ]

// data/fills.json
[ { "lat": 26.50449, "lon": -102.68093, "color": "extraFill", "maps": ["radar", "forecast"] } ]
```

These are maintained visually with the **marker editor**, which overlays the
rendered map on the original WeatherStar basemap so positions can be compared
and corrected:

```sh
npm run editor     # http://localhost:8080/editor/
```

See [`editor/README.md`](editor/README.md) for how it works.

## Layout

```
src/           the render pipeline
  index.mjs      renders every region × map
  drawmap.mjs    draws the sections and runs the post steps
  REGIONS.mjs    bounding boxes and output sizes
  MAPS.mjs       palettes, section lists, post lists
  stations/      station labels
  roadicons/     interstate shields
  fills/         flood fills from marked points
  palettize/     rgba -> indexed color
  plot/          draws OpenStreetMap ways
  plotfromshape/ draws shapefile rings
editor/        the marker editor (its own README)
getdata/       refetches road data from the Overpass API
tools/         one-off utilities
data/          shapefiles, road data, marker positions
fonts/         Star4000, the WeatherStar typeface
reference-images/  the original basemap, and the shield icon
```

## Refreshing the road data

`data/roads.json.gz` is committed, so this is only needed to change the query or
the area it covers:

```sh
node getdata/index.mjs
```

It pulls interstates from the [Overpass API](https://overpass-api.de/) for the
bounds set in `getdata/index.mjs` and writes them gzipped.

## Fonts

Labels are drawn with Star4000, registered from a `.ttf`. node-canvas goes
through FreeType, which reads `ttf`/`otf` but **not** `woff` — a woff registers
without error and then draws `.notdef` boxes. Convert first:

```sh
node tools/woff2ttf.mjs "fonts/Star4000.woff" "fonts/Star4000.ttf"
```

## Scripts

| command | does |
| --- | --- |
| `node src/index.mjs` | render every region × map |
| `npm run editor` | serve the marker editor |
| `npm run editor:verify` | check the editor's math against the pipeline |
| `npm run editor:verify-ui` | drive the editor in headless Chrome |
| `npm run lint` | eslint over `src/` |

## Data sources

- Roads — [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
  via the Overpass API (ODbL)
- Land and lakes — [Natural Earth](https://www.naturalearthdata.com/) 1:50m
  (public domain)
- States and counties — [US Census Bureau](https://www.census.gov/geographies/mapping-files/time-series/geo/carto-boundary-file.html)
  2020 cartographic boundary files
- Star4000, the WeatherStar 4000 typeface, in `fonts/`

## License

MIT © Matt Walsh

The code is MIT. The data and font in this repository are covered by their own
terms, linked above.
