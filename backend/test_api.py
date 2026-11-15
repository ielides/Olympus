from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_health():
    assert client.get("/health").status_code == 200

def test_points():
    response = client.get("/points-of-interest")
    assert response.status_code == 200
    assert any(p["kind"] == "aterrizaje" for p in response.json())

def test_route_demo(monkeypatch):
    monkeypatch.setattr('main.ENGINE', 'demo')
    response = client.post("/routes/plan", json={"originId":"landing-jezero", "destinationId":"delta-jezero", "mission":"robotica"})
    assert response.status_code == 200
    data = response.json()
    assert data["geometry"]["type"] == "LineString"
    assert data["safetyIndex"] is None
    assert data["status"] == "demostracion"
    assert data["distanceKm"] > 0

def test_invalid_origin():
    response = client.post("/routes/plan", json={"originId":"delta-jezero", "destinationId":"crater-jezero", "mission":"humana"})
    assert response.status_code == 400

def test_other_region():
    response = client.post("/routes/plan", json={"originId":"landing-jezero", "destinationId":"gale", "mission":"humana"})
    assert response.status_code == 400


def test_coordinates_validated():
    response=client.post('/routes/coordinates',json={'points':[{'lon':200,'lat':0},{'lon':0,'lat':0}]})
    assert response.status_code == 422


def test_coordinates_do_not_fallback_to_demo(monkeypatch):
    from pathlib import Path
    monkeypatch.setattr('routing.RASTER',Path('missing-file.tif'))
    response=client.post('/routes/coordinates',json={'points':[{'lon':0,'lat':0},{'lon':1,'lat':0}]})
    assert response.status_code==422
    assert 'Genera primero' in response.json()['detail']


def test_custom_active_layers():
    response = client.post('/routes/coordinates', json={
        'points': [{'lon': 77.45, 'lat': 18.45}, {'lon': 77.35, 'lat': 18.5}],
        'mission': 'robotica',
        'activeLayers': ['geologia', 'pendientes']
    })
    assert response.status_code == 200
    data = response.json()
    assert data['distanceKm'] > 0
    assert 'Capas calculadas (2)' in data['notes']


def test_empty_active_layers():
    response = client.post('/routes/coordinates', json={
        'points': [{'lon': 77.45, 'lat': 18.45}, {'lon': 77.35, 'lat': 18.5}],
        'mission': 'robotica',
        'activeLayers': []
    })
    assert response.status_code == 422
    assert 'al menos una capa' in response.json()['detail']


def test_multipoint_and_human_level_limit():
    response = client.post('/routes/coordinates', json={
        'points': [
            {'lon': 76.834, 'lat': 19.598},
            {'lon': 77.756, 'lat': 19.457},
            {'lon': 76.974, 'lat': 19.176},
        ],
        'mission': 'humana',
    })
    assert response.status_code == 200
    data = response.json()
    assert data['distanceKm'] > 0
    assert data['riskFactors'] is not None
    assert data['riskFactors']['nivel3Pct'] == 0
    assert '2 tramos' in data['notes']

    rejected = client.post('/routes/coordinates', json={
        'points': [{'lon': 77.45, 'lat': 18.45}, {'lon': 77.35, 'lat': 18.5}],
        'mission': 'humana',
    })
    assert rejected.status_code == 422
    assert 'máximo 2' in rejected.json()['detail']

