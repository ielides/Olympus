export type MissionType = 'robotica' | 'humana';
export type LayerKey = 'topografia' | 'termica' | 'optica';
export type Coordinate = { lon: number; lat: number };
export interface HazardManifest {
  resolutionM: number;
  boundsLonLat: [number, number, number, number];
  counts: Record<string, number>;
  previewFactor: number;
  generatedAt: string;
}

export interface PointOfInterest {
  id: string;
  name: string;
  kind: 'ciencia' | 'aterrizaje';
  region: string;
  lat: number;
  lon: number;
  detail: string;
}

export interface RouteResult {
  originId: string;
  destinationId: string;
  distanceKm: number;
  safetyIndex: number | null;
  status: 'demostracion' | 'calculada' | 'datos_insuficientes';
  notes: string;
  geometry: { type: 'LineString'; coordinates: [number, number][] }; // GeoJSON [lon,lat]
  riskFactors: Record<string, number> | null;
  dataConfidence: number | null;
}
