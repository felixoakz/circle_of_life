# Data sources, versions, licences and attribution

Everything here was validated on 2026-10-27.

## 1. Bulk data (used by `species ingest`)

### Open Tree of Life: synthetic tree opentree16.1 (released 2025-12-20)
- **File:** `labelled_supertree.tre`, 31 MB. Newick, ids only (`ott…` or `mrcaott…ott…`), with no branch lengths and therefore **no dates**.
- **URL:** https://files.opentreeoflife.org/synthesis/opentree16.1/output/labelled_supertree/labelled_supertree.tre
- **Local copy:** `data/raw/labelled_supertree.tre` (`make fetch-data`).
- **Licence:** CC0 1.0.
- **Contents:**
  - 2,725,682 nodes, of which 2,385,875 are tips and 126,018 are unnamed `mrca` nodes
  - root `ott93302`, "cellular organisms"
  - no viruses
  - only about 160k tips are placed by phylogenetic studies; the rest are grafted from the taxonomy, which is why there are large polytomies
- **Cite:**
  - Open Tree of Life (2025). Synthetic tree opentree16.1. Zenodo, doi:10.5281/zenodo.3937741.
  - Hinchliff, C. E. et al. (2015). Synthesis of phylogeny and taxonomy into a comprehensive tree of life. *PNAS* 112(41):12764–12769. doi:10.1073/pnas.1423041112.

### Open Tree Taxonomy (OTT) 3.7.3
- **Archive:** `ott3.7.3.tgz`, containing `taxonomy.tsv` (417 MB, 4.53M rows), `synonyms.tsv`, `forwards.tsv` and `version.txt` (which reads "3.7draft3").
- **URL:** https://files.opentreeoflife.org/ott/ott3.7.3/ott3.7.3.tgz
- **Local copy:** `data/raw/ott3.7.3/` (`make fetch-data`).
- **Licence:** CC0 1.0.
- **Format:** the separator is `\t|\t` and every line ends with `\t|\t`. The columns are `uid|parent_uid|name|rank|sourceinfo|uniqname|flags`. `sourceinfo` holds cross-ids such as `ncbi:9606,gbif:2436436,…`.
- **Cite:** Rees, J. A. & Cranston, K. (2017). Automated assembly of a reference taxonomy for phylogenetic data synthesis. *Biodiversity Data Journal* 5:e12581. OTT 3.7.3 on Zenodo, doi:10.5281/zenodo.3937750.

### GBIF Backbone Taxonomy: vernacular names (P11)
- **Archive:** `backbone.zip`, 926 MB, a Darwin Core Archive frozen on 2023-08-28. `VernacularName.tsv` is keyed by GBIF `taxonID`.
- **URL:** https://hosted-datasets.gbif.org/datasets/backbone/current/backbone.zip
- **Licence:** CC BY 4.0.
- **Use:** names in `en` and `pt` only, joined to OTT nodes through the `gbif:` ids in OTT `sourceinfo` (an integer join with no name matching). Accept both 2- and 3-letter language codes.
- **Why this over Catalogue of Life XR.** COL XR has more vernaculars (2.05M) and a smaller download (137 MB ColDP). But it has no OTT↔COL id mapping, so it would need fuzzy name matching with homonym handling. The GBIF route reuses ids we already parse.
- **Cite:** GBIF Secretariat (2023). GBIF Backbone Taxonomy. Checklist dataset doi:10.15468/39omei, accessed via GBIF.org.

### Major group roots (OTT ids, verified present in synth 16.1)
| Group | OTT ids |
|---|---|
| Animals | Metazoa 691846 |
| Fungi | Fungi 352914 |
| Plants | Chloroplastida 361838, Rhodophyta 878953, Glaucophyta 664970 |
| Protists | rest of Eukaryota 304358 |
| Bacteria | 844192 |
| Archaea | 996421 |

Archaeplastida 5268475 is **not** a node in synth 16.1, because it is broken there.

## 2. Live APIs (lazy enrichment, cached in `cache.db`)

| Source | Endpoint | Gives | Licence / terms |
|---|---|---|---|
| Wikidata Action API | `https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=haswbstatement:P9157={ott}` → `action=wbgetentities&ids=…&props=claims\|sitelinks&sitefilter=enwiki\|ptwiki` | QID; P225 taxon name; P18 image; P141 IUCN status; P846 GBIF id; Wikipedia titles. Verified: ott770315 → Q15978631 (2 hits; choose by P225) | CC0 |
| Wikipedia REST | `https://en.wikipedia.org/api/rest_v1/page/summary/{title}` | extract, description, thumbnail, page URL | Text CC BY-SA 4.0. Attribute and link |
| Wikimedia Commons | `https://commons.wikimedia.org/w/api.php?action=query&titles=File:{f}&prop=imageinfo&iiprop=extmetadata\|url&iiurlwidth=640&iiextmetadatafilter=LicenseShortName\|Artist\|LicenseUrl&format=json` | image URL, artist (HTML; strip it), licence | per file. Show it every time |
| GBIF species | `https://api.gbif.org/v1/species/{key}` | authorship, publishedIn, vernacularName, rank | CC BY 4.0 |
| GBIF occurrences | `https://api.gbif.org/v1/occurrence/search?taxonKey={k}&limit=0&facet=country&facetLimit=300&hasGeospatialIssue=false&occurrenceStatus=PRESENT` | total and per-country counts | CC BY 4.0 (aggregate) |
| GBIF maps (browser, direct) | `https://api.gbif.org/v2/map/occurrence/density/{z}/{x}/{y}@1x.png?taxonKey={k}&style=…`; capabilities: `/v2/map/occurrence/density/capabilities.json?taxonKey={k}` | density map tiles | Attribute "Occurrence data © GBIF.org contributors" |
| GBIF v2 match (IUCN fallback) | `https://api.gbif.org/v2/species/match?scientificName={name}` | `additionalStatus[datasetAlias=IUCN].statusCode` | CC BY 4.0. The IUCN category is a fact; no IUCN API is used |
| iNaturalist (image fallback) | `https://api.inaturalist.org/v1/taxa?q={name}&per_page=5` (exact name match) | `default_photo.medium_url`, `license_code`, `attribution` | Only `cc0`, `cc-by`, `cc-by-sa`, `cc-by-nc` (this is a non-commercial portfolio). Never a null licence. Always attribute. ≤ 1 request/s |

**Etiquette**
- Every request sends `User-Agent: CircleOfLife/0.1 (+{SPECIES_PUBLIC_URL}; {SPECIES_CONTACT})`. Wikimedia blocks generic UAs.
- On `429` or `Retry-After`, back off.
- Concurrency is capped per host: GBIF 8, Wikimedia 4, iNat 1.
- Store URLs and attribution, never image bytes.

**Not used**
- The IUCN Red List API: it needs a token and its terms are restrictive.
- WDQS SPARQL: the Action API is simpler and more reliable for single lookups.
- Wikidata JSON dumps: too heavy.
- OneZoom code and data: custom non-OSI licence. Only ideas are taken.
- Catalogue of Life direct: GBIF already reflects it.

## 3. Attribution text

**Panel footer** (built per node from the sources actually used):
> Text: Wikipedia (CC BY-SA 4.0) · Image: {Artist}, {Licence} via {Wikimedia Commons | iNaturalist} · Occurrences: GBIF.org · Tree: Open Tree of Life

**Data & credits dialog:**
- **Tree:** Open Tree of Life synthetic tree opentree16.1 and Open Tree Taxonomy 3.7.3 (CC0). Hinchliff et al. 2015, PNAS. doi:10.5281/zenodo.3937741, doi:10.5281/zenodo.3937750.
- **Common names:** GBIF Backbone Taxonomy (2023), CC BY 4.0, doi:10.15468/39omei.
- **Species details:** Wikidata (CC0); Wikipedia (CC BY-SA 4.0); images from Wikimedia Commons and iNaturalist under the licence shown with each image; occurrence data © GBIF.org contributors (CC BY 4.0); conservation status from IUCN Red List categories via Wikidata/GBIF.
- **Notes:**
  - 2,385,875 tips, of which 2,273,995 are species-rank. The rest are subspecies, varieties and unranked terminal taxa.
  - The tree has no branch lengths, so there are no dates.
  - Large fans are polytomies, where relationships are unresolved.
- **Inspiration:** the "Circle of Life" visualisation popularised from Hinchliff et al. 2015, as covered in Scientific American's "All 2.3 Million Species Are Mapped into a Single Circle of Life".

## 4. Versions pinned by this project
- `dataVersion` = `otl16.1-ott3.7.3-{hash6}`. It is computed at ingest and changes the tile URLs, which busts caches.
- **Updating to a new synth release** means: new URLs in `make fetch-data` (Makefile), then re-ingest, re-check the group root ids (print them in the dry run), then upload `tree.db`. `cache.db` keys on OpenTree node ids, so it survives a re-ingest. mrca ids may change, which only costs refetches.
