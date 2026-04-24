// ingest-usgs-nwis — daily USGS National Water Information System (NWIS) ingest.
// Queries the Instantaneous Values service for the Chesapeake bbox and commits
// Station + Observation things into the home repo.
import type { AddOperation, Operation } from "@warmhub/sdk-ts";
import { clientFromEnv, homeRepo, splitRepo } from "./warmhub";

const BBOX = { minLat: 33.5, maxLat: 39.7, minLon: -78.0, maxLon: -75.0 };
// USGS Instantaneous Values service — https://waterservices.usgs.gov/rest/IV-Service.html
const IV_BASE = "https://waterservices.usgs.gov/nwis/iv/";

// Map USGS parameter codes to the Observation.parameter shape enum.
// Codes documented at https://help.waterdata.usgs.gov/parameter_cd
const PARAM_MAP: Record<string, { parameter: string; unit: string }> = {
  "00010": { parameter: "temperature_c",  unit: "C"     },
  "00060": { parameter: "discharge_cfs",  unit: "cfs"   },
  "00065": { parameter: "gage_height_ft", unit: "ft"    },
  "00300": { parameter: "do_mgl",         unit: "mg/L"  },
  "00613": { parameter: "nitrate_mgl",    unit: "mg/L"  },
  "00665": { parameter: "phosphorus_mgl", unit: "mg/L"  },
};

interface NwisSite {
  siteName: string;
  siteCode: Array<{ value: string; agencyCode?: string }>;
  geoLocation: { geogLocation: { latitude: number; longitude: number } };
}

interface NwisVariable {
  variableCode: Array<{ value: string }>;
  unit?: { unitCode?: string };
}

interface NwisReading {
  value: string;
  qualifiers: string[];
  dateTime: string;
}

interface NwisTimeSeries {
  sourceInfo: NwisSite;
  variable: NwisVariable;
  values: Array<{ value: NwisReading[] }>;
}

interface NwisResponse {
  value: { timeSeries: NwisTimeSeries[] };
}

// USGS qualifier codes → our quality_flag enum
function mapQuality(qualifiers: string[]): string {
  if (qualifiers.includes("A")) return "approved";
  if (qualifiers.includes("P")) return "provisional";
  if (qualifiers.includes("e") || qualifiers.includes("E")) return "corrected";
  return "raw";
}

async function fetchNwis(): Promise<NwisTimeSeries[]> {
  const params = new URLSearchParams({
    format: "json",
    bBox: `${BBOX.minLon},${BBOX.minLat},${BBOX.maxLon},${BBOX.maxLat}`,
    period: "P1D",
    parameterCd: Object.keys(PARAM_MAP).join(","),
    siteStatus: "active",
  });
  const res = await fetch(`${IV_BASE}?${params}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`USGS NWIS ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as NwisResponse;
  return body.value.timeSeries ?? [];
}

function buildOps(series: NwisTimeSeries[]): AddOperation[] {
  const seenStations = new Set<string>();
  const seenObs = new Set<string>();
  const ops: AddOperation[] = [];

  for (const ts of series) {
    const site = ts.sourceInfo.siteCode[0]?.value;
    if (!site) continue;
    const geo = ts.sourceInfo.geoLocation?.geogLocation;
    if (!geo) continue;

    if (!seenStations.has(site)) {
      seenStations.add(site);
      ops.push({
        operation: "add",
        kind: "thing",
        name: `Station/${site}`,
        data: {
          station_id: site,
          lat: geo.latitude,
          lon: geo.longitude,
          operator: "USGS-NWIS",
          kind: "stream-gauge",
        },
        skipExisting: true,
      });
    }

    const variableCode = ts.variable.variableCode[0]?.value;
    if (!variableCode) continue;
    const mapping = PARAM_MAP[variableCode];
    if (!mapping) continue;

    for (const group of ts.values) {
      for (const r of group.value) {
        const numericValue = Number(r.value);
        // USGS sentinel for missing data is -999999
        if (!Number.isFinite(numericValue) || numericValue < -9000) continue;

        const obsName = `Observation/${site}-${r.dateTime}-${mapping.parameter}`;
        if (seenObs.has(obsName)) continue;
        seenObs.add(obsName);
        ops.push({
          operation: "add",
          kind: "thing",
          name: obsName,
          data: {
            station: `Station/${site}`,
            timestamp: r.dateTime,
            parameter: mapping.parameter,
            value: numericValue,
            unit: mapping.unit,
            quality_flag: mapQuality(r.qualifiers ?? []),
            source_system: "usgs-nwis-iv",
          },
          skipExisting: true,
        });
      }
    }
  }

  return ops;
}

async function main() {
  const client = clientFromEnv();
  const { orgName, repoName } = splitRepo(homeRepo());

  const series = await fetchNwis();
  if (series.length === 0) {
    console.log(JSON.stringify({ commitId: null, opCount: 0, note: "no time series returned" }));
    return;
  }

  const ops = buildOps(series);
  const operations: Operation[] = ops;
  const today = new Date().toISOString().slice(0, 10);

  const result = await client.commit.apply(
    orgName,
    repoName,
    `USGS NWIS daily ingest ${today}`,
    operations,
    // Chunk large commits; NWIS can emit thousands of rows across sites.
    { chunkSize: 500 },
  );

  console.log(JSON.stringify({
    commitId: result.commitId,
    opCount: ops.length,
    stationsAdded: ops.filter((o) => o.name?.startsWith("Station/")).length,
    observationsAdded: ops.filter((o) => o.name?.startsWith("Observation/")).length,
  }));
}

main().catch((err) => { console.error(err); process.exit(1); });
