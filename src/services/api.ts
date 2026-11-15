import type { PointOfInterest, RouteResult, MissionType, Coordinate } from '../types/mission';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8081';

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json() as { detail?: string };
      if (typeof body.detail === 'string') message = body.detail;
    } catch { /* Error no JSON */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function fetchPoints(): Promise<PointOfInterest[]> {
  return parseResponse<PointOfInterest[]>(await fetch(`${API_BASE}/points-of-interest`));
}

export async function fetchHealth(): Promise<{status: string; route_engine: string; rasterReady: boolean}> {
  return parseResponse(await fetch(`${API_BASE}/health`));
}

export async function planCoordinates(points: Coordinate[], mission: MissionType, activeLayers?: string[]): Promise<RouteResult> {
  return parseResponse<RouteResult>(await fetch(`${API_BASE}/routes/coordinates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ points, mission, activeLayers }),
  }));
}

export async function planRoute(originId: string, destinationId: string, mission: MissionType, activeLayers?: string[]): Promise<RouteResult> {
  return parseResponse<RouteResult>(await fetch(`${API_BASE}/routes/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originId, destinationId, mission, activeLayers }),
  }));
}
