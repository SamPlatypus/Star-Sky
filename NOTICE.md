# Third-party data and algorithms

Star Sky bundles the following data (converted by `tools/build-data.mjs` into
`data/*.json`). None of it is fetched at run time.

| Data | Source | Terms |
| --- | --- | --- |
| Stars (positions, magnitudes, colours, spectral types, designations) | *The Bright Star Catalogue*, 5th revised ed., D. Hoffleit & W. H. Warren Jr. (1991), Yale University Observatory; distributed by the NASA Astronomical Data Center / CDS (catalogue V/50) | Free to use with acknowledgement |
| Proper star names | *IAU Catalog of Star Names (IAU-CSN)*, IAU Working Group on Star Names (WGSN) | IAU products are released under Creative Commons Attribution (CC BY 4.0) |
| Constellation figures and label points | [d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn | BSD-3-Clause, licence text below |
| Constellation boundaries (point lookup) | N. G. Roman (1987), *Identification of a Constellation from a Position*, PASP 99, 695 (CDS VI/42), as packaged in [astropy](https://www.astropy.org) | BSD-3-Clause (astropy), licence text below |
| Magnetic declination model | World Magnetic Model 2025, NOAA National Centers for Environmental Information and the British Geological Survey | Public domain (U.S. Government work) |
| Cities | [Natural Earth](https://www.naturalearthdata.com) populated places, 1:50m | Public domain |
| Time-zone reference points | IANA Time Zone Database (`zone.tab`) | Public domain |

Algorithms (re-implemented, no code copied): J. Meeus, *Astronomical Algorithms*
(2nd ed., 1998) for sidereal time, precession, the Sun and the Moon (ELP-2000/82
truncated series) and planetary magnitudes; E. M. Standish, *Keplerian Elements
for Approximate Positions of the Major Planets* (JPL); P. Schlyter, *How to
compute planetary positions* (outer-planet perturbations); T. Saemundsson (1986)
refraction formula; the WMM technical report for the spherical-harmonic synthesis.

The test suite uses [astronomy-engine](https://github.com/cosinekitty/astronomy)
(MIT licence) as a high-precision reference; it is a development dependency only
and is not shipped with the app.

---

## d3-celestial licence

```
Copyright (c) 2015, Olaf Frohn
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## astropy licence

```
Copyright (c) 2011-2026, Astropy Developers

All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice, this
  list of conditions and the following disclaimer in the documentation and/or
  other materials provided with the distribution.
* Neither the name of the Astropy Team nor the names of its contributors may be
  used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
