#!/usr/bin/env bash
# Downloads the raw catalogues used to generate data/*.json.
# Only needed when regenerating data; the app itself never goes online.
#
#   bash tools/fetch-sources.sh && node tools/build-data.mjs
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw
cd raw

fetch() { echo "-> $2"; curl -fsSL --retry 3 -o "$2" "$1"; }

# Yale Bright Star Catalogue, 5th revised ed. (Hoffleit & Warren 1991)
fetch http://tdc-www.harvard.edu/catalogs/bsc5.dat.gz bsc5.dat.gz
gunzip -f bsc5.dat.gz

# IAU Catalog of Star Names (WGSN)
fetch https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt IAU-CSN.txt

# Constellation lines + label positions (d3-celestial, BSD-3-Clause, Olaf Frohn)
fetch https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.json d3c-constellations.json
fetch https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json d3c-constellations.lines.json

# Constellation boundaries for point lookup (Roman 1987, CDS VI/42) as shipped with astropy
fetch https://raw.githubusercontent.com/astropy/astropy/main/astropy/coordinates/data/constellation_data_roman87.dat roman87.dat
fetch https://raw.githubusercontent.com/astropy/astropy/main/astropy/coordinates/data/constellation_names.dat constellation_names.dat

# Populated places (Natural Earth, public domain)
fetch https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places_simple.geojson ne_50m_places.geojson

# World Magnetic Model 2025 (NOAA NCEI, public domain)
fetch https://www.ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip WMM2025COF.zip
python3 -I -c "import zipfile; z = zipfile.ZipFile('WMM2025COF.zip'); [open(n.split('/')[-1], 'wb').write(z.read(n)) for n in z.namelist() if n.endswith(('WMM.COF', 'TestValues.txt'))]"

# Time zone reference coordinates (IANA tz database, public domain)
cp /usr/share/zoneinfo/zone.tab zone.tab
cp /usr/share/zoneinfo/tzdata.zi tzdata.zi

echo "done"
