import numpy as np
import pytest
from affine import Affine
from hazards import combine, overview_block, check_grid
from routing import astar, shortest_route, RouteError


def test_four_vetoes_lower_levels_and_unknown():
    a = np.ma.array([[1,2,3,4,1,1]], mask=[[0,0,0,0,1,1]])
    b = np.array([[1,1,2,1,4,3]])
    assert combine([a,b]).tolist() == [[1,2,3,4,4,0]]


def test_invalid_values_do_not_become_safe():
    assert combine([np.array([[0,5,np.nan,2.5]]),np.ones((1,4))]).tolist() == [[0,0,0,0]]


def test_preview_keeps_even_one_blocked_cell():
    a = np.ones((4,4),dtype=np.uint8)
    a[0,0]=4; a[2,2]=0
    assert overview_block(a,2).tolist() == [[4,1],[1,0]]


GRID = Affine(463,0,0,0,-463,10000)


def test_route_detours_around_four():
    levels=np.ones((7,7),dtype=np.uint8)
    levels[1:6,3]=4
    path,_=astar(levels,(3,1),(3,5),GRID,3396190)
    assert path[0]==(3,1) and path[-1]==(3,5)
    assert all(levels[p]!=4 for p in path)
    assert any(r in (0,6) for r,c in path)


def test_no_corner_cutting():
    path,_=astar(np.array([[1,4],[0,1]]),(0,0),(1,1),GRID,3396190)
    assert path is None


def test_blocked_endpoint_is_not_snapped():
    with pytest.raises(RouteError,match="nivel 4"):
        astar(np.array([[4,1],[1,1]]),(0,0),(1,1),GRID,3396190)


def test_cost_prefers_low_risk_detour():
    a=np.ones((5,9),dtype=np.uint8);a[2,2:7]=3
    path,_=astar(a,(2,0),(2,8),GRID,3396190)
    assert all(a[p]==1 for p in path)


def test_grid_rejects_wrong_resolution():
    from types import SimpleNamespace
    from rasterio.crs import CRS
    src=SimpleNamespace(count=1,crs=CRS.from_string('+proj=eqc +R=3396190 +units=m'),shape=(10,10),
                        transform=GRID,res=(20,20),name='high_resolution.tif')
    with pytest.raises(ValueError,match='400 m'):
        check_grid(src,src)


@pytest.mark.parametrize('seed',range(12))
@pytest.mark.parametrize('mission',['robotica','humana'])
def test_compiled_search_matches_reference_cost_and_safe_edges(seed,mission):
    rng=np.random.default_rng(seed)
    levels=rng.integers(0,5,(15,17),dtype=np.uint8)
    levels[0,0]=1;levels[-1,-1]=1
    old,old_cost=astar(levels,(0,0),(14,16),GRID,3396190,mission)
    new,new_cost=shortest_route(levels,(0,0),(14,16),GRID,3396190,mission)
    assert (old is None)==(new is None)
    if new:
        assert new_cost==pytest.approx(old_cost,rel=1e-8)
        for (r,c),(nr,nc) in zip(new,new[1:]):
            assert levels[nr,nc] in (1,2,3)
            if r!=nr and c!=nc:
                assert levels[r,nc] in (1,2,3) and levels[nr,c] in (1,2,3)


def test_compiled_blocked_and_same_cell():
    with pytest.raises(RouteError,match='Destino'):
        shortest_route(np.array([[1,4]]),(0,0),(0,1),GRID,3396190)
    assert shortest_route(np.ones((1,1),dtype=np.uint8),(0,0),(0,0),GRID,3396190)==([(0,0)],0.)
