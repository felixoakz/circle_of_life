// Payload types of the read API (PLAN §5.1).

export interface GroupInfo {
  id: number;
  name: string;
  rootIds: string[];
  tipCount: number;
}

/** A contiguous run of tips of one group, in u32 angle units. */
export interface GroupRun {
  group: number;
  angleLo: number;
  angleHi: number;
}

export interface Meta {
  dataVersion: string;
  tipCount: number;
  speciesCount: number;
  nodeCount: number;
  tileP: number;
  maxLevel: number;
  r0: number;
  groups: GroupInfo[];
  runs: GroupRun[];
  home: { id: number; nodeId: string; angle: number } | null;
}

/** One ancestor in a node's lineage (root first). */
export interface LineageEntry {
  id: number;
  nodeId: string;
  /** null for unnamed (mrca) nodes. */
  name: string | null;
  rank: string | null;
  group: number;
  angle: number;
  r: number;
}

/** One of a node's largest children (`children.top`). */
export interface ChildEntry {
  id: number;
  nodeId: string;
  name: string | null;
  rank: string | null;
  group: number;
  leafCount: number;
}

/** `GET /api/nodes/{ref}` (PLAN §5.1). */
export interface NodeInfo {
  id: number;
  nodeId: string;
  /** null for unnamed (mrca) nodes. */
  name: string | null;
  rank: string | null;
  group: number;
  flags: number;
  /** Tips in the clade (1 for a tip). */
  leafCount: number;
  childCount: number;
  angle: number;
  arcLo: number;
  arcHi: number;
  r: number;
  level: number;
  ids: { ott: number | null; gbif: number | null; ncbi: number | null };
  /** Root first, parent last; the node itself is not included. */
  lineage: LineageEntry[];
  /** `total` direct children; `top` the 50 largest by leaf count. */
  children: { total: number; top: ChildEntry[] };
  /** For an unnamed node, its nearest named ancestor. */
  namedAncestor: LineageEntry | null;
  /** Best English (else Portuguese) common name from the GBIF backbone (P11), if any. */
  commonName: string | null;
}

/** One result of `GET /api/search` (PLAN §5.1): the node's own fields plus the match. */
export interface SearchHit {
  id: number;
  nodeId: string;
  name: string | null;
  rank: string | null;
  group: number;
  flags: number;
  leafCount: number;
  childCount: number;
  level: number;
  angle: number;
  arcLo: number;
  arcHi: number;
  r: number;
  /** The name that matched: the scientific name, or (P11) a common name. */
  matched: string;
  matchedKind: 'scientific' | 'vernacular';
  /** Language of a common-name match ("en", "pt"); null for a scientific one. */
  matchedLang: string | null;
  /** The node's best common name (P11), whatever matched. */
  commonName: string | null;
  /** Up to 3 named ancestors above genus, broadest first. */
  lineage: string[];
}

/** Which node borrowed text or an image is really about (an ancestor). */
export interface AboutRef {
  nodeId: string;
  name: string;
  rank: string | null;
}

/** `GET /api/nodes/{ref}/about` (PLAN §6.3): enrichment, every part optional. */
export interface About {
  nodeId: string;
  taxonomy: { authorship: string | null; publishedIn: string | null; source: string } | null;
  /** English common names, best first. */
  commonNames: string[];
  summary: {
    text: string;
    description: string | null;
    title: string;
    url: string;
    license: string;
    about: AboutRef | null;
  } | null;
  image: {
    url: string;
    width: number | null;
    height: number | null;
    credit: string | null;
    license: string;
    licenseUrl: string | null;
    /** "Wikimedia Commons" or "iNaturalist". */
    source: string;
    pageUrl: string;
    about: AboutRef | null;
  } | null;
  /** IUCN Red List category code and where it came from. */
  status: { code: string; source: string } | null;
  distribution: {
    occurrences: number;
    /** [ISO alpha-2, records], most first, above the noise threshold. */
    countries: [string, number][];
    countryTotal: number;
    gbifKey: number;
    /** [minLng, minLat, maxLng, maxLat] of the density map's data. */
    bbox: [number, number, number, number] | null;
  } | null;
  /** Always present; shown when there is no summary. */
  generated: string;
  links: {
    opentree: string;
    wikipedia: string | null;
    wikipediaPt: string | null;
    wikidata: string | null;
    gbif: string | null;
    inat: string | null;
    iucn: string | null;
  };
  /** Sources that failed or timed out ("Wikidata", "GBIF", …). */
  failed: string[];
  complete: boolean;
  fetchedAt: number;
}
