from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_health():
    assert client.get("/health").status_code == 200

def test_points():
    response = client.get("/points-of-interest")
    assert response.status_code == 200
    assert any(p["kind"] == "aterrizaje" for p in response.json())

def test_route_demo():
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
