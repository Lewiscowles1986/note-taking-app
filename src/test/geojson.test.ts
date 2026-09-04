import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import GeoJsonBlock from '../components/GeoJsonBlock';
import L from 'leaflet';

vi.mock('leaflet', () => {
  class MockMarker {}
  (MockMarker.prototype as Record<string, unknown>).options = { pane: 'markerPane' };
  (MockMarker.prototype as Record<string, unknown>).initialize = vi.fn();
  (MockMarker as unknown as Record<string, unknown>).extend = vi.fn().mockImplementation(() => MockMarker);
  (MockMarker as unknown as Record<string, unknown>).include = vi.fn().mockImplementation(() => MockMarker);

  const mockFeatureGroup = class {};
  (mockFeatureGroup as unknown as Record<string, unknown>).extend = vi.fn().mockImplementation(() => mockFeatureGroup);
  (mockFeatureGroup as unknown as Record<string, unknown>).include = vi.fn().mockImplementation(() => mockFeatureGroup);
  (mockFeatureGroup.prototype as Record<string, unknown>).addLayer = vi.fn().mockReturnThis();
  (mockFeatureGroup.prototype as Record<string, unknown>).addTo = vi.fn().mockReturnThis();

  const mockMapInstance = {
    setView: vi.fn().mockReturnThis(),
    fitBounds: vi.fn().mockReturnThis(),
    remove: vi.fn(),
    invalidateSize: vi.fn(),
    addLayer: vi.fn().mockReturnThis(),
  };

  // Stand-in for Leaflet vector layers (polylines, polygons) that the
  // component must add straight to the map instead of the cluster group.
  const makeVectorLayer = () => ({
    addTo: vi.fn().mockReturnThis(),
    bindPopup: vi.fn().mockReturnThis(),
  });

  // Most recent payload handed to L.geoJSON; drives what eachLayer emits.
  let lastGeoJsonData: unknown = null;

  const collectFeatures = (data: unknown): unknown[] => {
    if (!data || typeof data !== 'object') return [];
    const record = data as Record<string, unknown>;
    if (record.type === 'FeatureCollection' && Array.isArray(record.features)) {
      return record.features;
    }
    return [data];
  };

  const geometryTypeOf = (item: unknown): string | null => {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    if (record.type === 'Feature') {
      const geometry = record.geometry as Record<string, unknown> | null | undefined;
      return geometry && typeof geometry.type === 'string' ? geometry.type : null;
    }
    return typeof record.type === 'string' ? record.type : null;
  };

  const mockGeoJsonLayer = {
    addTo: vi.fn().mockReturnThis(),
    remove: vi.fn().mockReturnThis(),
    bindPopup: vi.fn().mockReturnThis(),
    getBounds: vi.fn().mockReturnValue({
      isValid: vi.fn().mockReturnValue(true),
      getSouthWest: vi.fn().mockReturnValue({ lat: 38.88, lng: -77.091 }),
      getNorthEast: vi.fn().mockReturnValue({ lat: 38.88, lng: -77.091 }),
    }),
    // Non-marker layers emitted by the most recent eachLayer run.
    vectorLayers: [] as ReturnType<typeof makeVectorLayer>[],
    eachLayer: vi.fn().mockImplementation((callback: (layer: unknown) => void) => {
      mockGeoJsonLayer.vectorLayers.length = 0;
      const features = collectFeatures(lastGeoJsonData);
      if (features.length === 0) {
        // Pass a mock marker to trigger point clustering
        callback(new MockMarker());
        return;
      }
      for (const feature of features) {
        if (geometryTypeOf(feature) === 'Point') {
          callback(new MockMarker());
        } else {
          const vectorLayer = makeVectorLayer();
          mockGeoJsonLayer.vectorLayers.push(vectorLayer);
          callback(vectorLayer);
        }
      }
    }),
  };

  const mockMarkerClusterInstance = {
    addLayer: vi.fn().mockReturnThis(),
    addTo: vi.fn().mockReturnThis(),
  };

  // Base mock object containing specific mocked methods used in our components/tests
  const leafletBaseMock: Record<string, unknown> = {
    map: vi.fn().mockImplementation(() => mockMapInstance),
    tileLayer: vi.fn().mockReturnValue({
      addTo: vi.fn(),
    }),
    geoJSON: vi.fn().mockImplementation((data: unknown, options?: { onEachFeature?: (feature: unknown, layer: unknown) => void }) => {
      lastGeoJsonData = data;
      if (options?.onEachFeature) {
        for (const feature of collectFeatures(data)) {
          options.onEachFeature(feature, mockGeoJsonLayer);
        }
      }
      return mockGeoJsonLayer;
    }),
    markerClusterGroup: vi.fn().mockImplementation(() => mockMarkerClusterInstance),
    Marker: MockMarker,
    FeatureGroup: mockFeatureGroup,
    Icon: {
      prototype: {
        options: {},
      },
      Default: {
        prototype: {
          options: {},
        },
        mergeOptions: vi.fn(),
      },
    },
  };

  // Proxy to return a stub with .extend and standard prototype for any missing leaflet property accessed by plugins
  const leafletMock = new Proxy(leafletBaseMock, {
    get(target, prop) {
      if (prop in target) {
        return target[prop as string];
      }
      const mockClass = class {} as unknown as Record<string, unknown>;
      (mockClass.prototype as Record<string, unknown>).options = { pane: 'markerPane' };
      (mockClass.prototype as Record<string, unknown>).initialize = vi.fn();
      (mockClass.prototype as Record<string, unknown>).addLayer = vi.fn().mockReturnThis();
      (mockClass.prototype as Record<string, unknown>).addTo = vi.fn().mockReturnThis();
      mockClass.extend = vi.fn().mockImplementation(() => mockClass);
      mockClass.include = vi.fn().mockImplementation(() => mockClass);
      return mockClass;
    }
  });

  // Set global L for leaflet.markercluster plugin compatibility
  (global as Record<string, unknown>).L = leafletMock;
  (window as unknown as Record<string, unknown>).L = leafletMock;

  return {
    default: leafletMock,
    ...leafletMock,
  };
});

describe('GeoJsonBlock component', () => {
  const validGeoJson = `{
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "properties": { "name": "Test Point" },
        "geometry": {
          "type": "Point",
          "coordinates": [-77.091, 38.88]
        }
      }
    ]
  }`;

  const invalidGeoJson = `{
    "type": "FeatureCollection",
    "features": [
  `;

  const invalidTypeGeoJson = `{
    "type": "NotAGeoJsonType",
    "features": []
  }`;

  // Payloads driving the remaining GeoJsonBlock branches: popup formatting,
  // property-less features, marker batch clustering, mixed vector geometry,
  // and a second payload for prop-change re-renders.
  const richPropsGeoJson = `{
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "properties": { "name": "Headquarters", "floors": 3, "tags": ["office", "hq"] },
        "geometry": { "type": "Point", "coordinates": [-77.091, 38.88] }
      }
    ]
  }`;

  const noPropsGeoJson = `{
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "properties": {},
        "geometry": { "type": "Point", "coordinates": [0, 0] }
      }
    ]
  }`;

  const multiPointGeoJson = `{
    "type": "FeatureCollection",
    "features": [
      { "type": "Feature", "properties": { "name": "Alpha" }, "geometry": { "type": "Point", "coordinates": [-77.0, 38.8] } },
      { "type": "Feature", "properties": { "name": "Beta" }, "geometry": { "type": "Point", "coordinates": [-78.0, 39.8] } },
      { "type": "Feature", "properties": { "name": "Gamma" }, "geometry": { "type": "Point", "coordinates": [-79.0, 40.8] } }
    ]
  }`;

  const mixedGeometryGeoJson = `{
    "type": "FeatureCollection",
    "features": [
      { "type": "Feature", "properties": { "name": "Depot" }, "geometry": { "type": "Point", "coordinates": [-77.0, 38.8] } },
      { "type": "Feature", "properties": { "route": "Blue Line" }, "geometry": { "type": "LineString", "coordinates": [[-77.0, 38.8], [-78.5, 39.5]] } }
    ]
  }`;

  const secondValidGeoJson = `{
    "type": "FeatureCollection",
    "features": [
      { "type": "Feature", "properties": { "name": "Annex" }, "geometry": { "type": "Point", "coordinates": [-80.0, 41.0] } }
    ]
  }`;

  type MockedGeoJsonLayer = {
    bindPopup: Mock;
    getBounds: Mock;
    vectorLayers: Array<{ addTo: Mock }>;
  };

  // Singleton layer instance returned by the most recent L.geoJSON call.
  const grabGeoJsonLayer = () =>
    vi.mocked(L.geoJSON).mock.results[0].value as unknown as MockedGeoJsonLayer;

  const grabMapInstance = () => vi.mocked(L.map).mock.results[0].value;

  // The leaflet.markercluster plugin overwrites the mocked markerClusterGroup
  // factory at import time, so grab the cluster group instance that the
  // component actually passes to map.addLayer.
  const grabClusterGroup = () => {
    const addLayerCall = vi.mocked(grabMapInstance().addLayer).mock.calls[0];
    return addLayerCall[0] as unknown as { addLayer: Mock };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders tab buttons for Map Preview and Code', () => {
    render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
    expect(screen.getByText('Map Preview')).toBeInTheDocument();
    expect(screen.getByText('Code')).toBeInTheDocument();
  });

  it('initializes map with leaflet on render', async () => {
    render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
    expect(L.map).toHaveBeenCalled();
    expect(L.tileLayer).toHaveBeenCalled();
    expect(L.geoJSON).toHaveBeenCalled();
  });

  it('allows toggling to raw code view and back', async () => {
    render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
    
    // Switch to code tab
    const codeTabButton = screen.getByText('Code');
    fireEvent.click(codeTabButton);
    
    expect(screen.getByText(/"name": "Test Point"/)).toBeInTheDocument();

    // Switch back to Map Preview tab
    const mapTabButton = screen.getByText('Map Preview');
    fireEvent.click(mapTabButton);
    
    // Map container should exist
    expect(L.map).toHaveBeenCalled();
  });

  it('destroys Leaflet map instance on switching to code tab and recreates it when switching back to preview (regression test)', async () => {
    const { unmount } = render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
    expect(L.map).toHaveBeenCalledTimes(1);

    const mockMapInstance = vi.mocked(L.map).mock.results[0].value;
    expect(mockMapInstance.remove).not.toHaveBeenCalled();

    // Switch to Code tab
    const codeTabButton = screen.getByText('Code');
    fireEvent.click(codeTabButton);
    expect(mockMapInstance.remove).toHaveBeenCalledTimes(1);

    // Switch back to Map Preview tab
    const mapTabButton = screen.getByText('Map Preview');
    fireEvent.click(mapTabButton);
    expect(L.map).toHaveBeenCalledTimes(2);

    unmount();
  });

  it('renders error alert when given invalid JSON', () => {
    render(React.createElement(GeoJsonBlock, { code: invalidGeoJson }));
    expect(screen.getByText('GeoJSON Error')).toBeInTheDocument();
    expect(screen.queryByText('Map Preview')).not.toBeInTheDocument();
  });

  it('renders error alert when type is invalid GeoJSON type', () => {
    render(React.createElement(GeoJsonBlock, { code: invalidTypeGeoJson }));
    expect(screen.getByText('GeoJSON Error')).toBeInTheDocument();
    expect(screen.getByText(/Invalid GeoJSON: Object must have a valid GeoJSON "type" field/)).toBeInTheDocument();
  });

  it('configures Leaflet map with scrollWheelZoom disabled to prevent scroll hijacking (regression test)', () => {
    render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
    expect(L.map).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({ scrollWheelZoom: false })
    );
  });

  it('creates and adds a markerClusterGroup containing point markers to the map (regression test)', () => {
    render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
    expect(L.MarkerClusterGroup).toBeDefined();
    const mockMapInstance = vi.mocked(L.map).mock.results[0].value;
    expect(mockMapInstance.addLayer).toHaveBeenCalled();
  });

  it('binds a popup with a formatted property table to features that have properties', () => {
    render(React.createElement(GeoJsonBlock, { code: richPropsGeoJson }));
    const layer = grabGeoJsonLayer();
    expect(layer.bindPopup).toHaveBeenCalledTimes(1);
    const popupHtml = vi.mocked(layer.bindPopup).mock.calls[0][0] as string;
    expect(popupHtml).toContain('<table');
    expect(popupHtml).toContain('>name</td>');
    expect(popupHtml).toContain('Headquarters</td>');
    // Primitive properties are inlined, object/array ones are JSON stringified
    expect(popupHtml).toContain('>3</td>');
    expect(popupHtml).toContain('["office","hq"]');
  });

  it('skips popup binding for features without properties', () => {
    render(React.createElement(GeoJsonBlock, { code: noPropsGeoJson }));
    expect(grabGeoJsonLayer().bindPopup).not.toHaveBeenCalled();
    expect(L.map).toHaveBeenCalled();
  });

  it('routes every point feature into the marker cluster group', () => {
    render(React.createElement(GeoJsonBlock, { code: multiPointGeoJson }));
    const cluster = grabClusterGroup();
    expect(cluster.addLayer).toHaveBeenCalledTimes(3);
    expect(grabMapInstance().addLayer).toHaveBeenCalledWith(cluster);
  });

  it('adds non-marker vector layers directly to the map while only points are clustered', () => {
    render(React.createElement(GeoJsonBlock, { code: mixedGeometryGeoJson }));
    // Only the Point feature is clustered; the LineString bypasses the cluster
    expect(grabClusterGroup().addLayer).toHaveBeenCalledTimes(1);
    const layer = grabGeoJsonLayer();
    expect(layer.vectorLayers).toHaveLength(1);
    expect(layer.vectorLayers[0].addTo).toHaveBeenCalledWith(grabMapInstance());
  });

  it('centers a single-point dataset with the default zoom level of 13', () => {
    render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
    // The mocked bounds collapse to one point, so the component uses setView
    expect(grabMapInstance().setView).toHaveBeenCalledWith({ lat: 38.88, lng: -77.091 }, 13);
  });

  it('invalidates the map size after the deferred layout timer fires', async () => {
    render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
    const mapInstance = grabMapInstance();
    vi.mocked(mapInstance.invalidateSize).mockClear();
    await waitFor(() => expect(mapInstance.invalidateSize).toHaveBeenCalled());
  });

  it('renders the error alert when adding GeoJSON layers to the map throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(L.tileLayer).mockImplementationOnce(() => {
      throw new Error('tile layer failed');
    });
    try {
      render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
      expect(screen.getByText('GeoJSON Error')).toBeInTheDocument();
      expect(screen.getByText('tile layer failed')).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('falls back to a generic error message when a non-Error is thrown while rendering layers', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(L.map).mockImplementationOnce(() => {
      throw 'map exploded';
    });
    try {
      render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
      expect(screen.getByText('GeoJSON Error')).toBeInTheDocument();
      expect(screen.getByText('Error rendering GeoJSON layers')).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('recreates the map and fits bounds with padding when the geojson payload changes', () => {
    const { rerender } = render(React.createElement(GeoJsonBlock, { code: validGeoJson }));
    expect(L.map).toHaveBeenCalledTimes(1);
    const mapInstance = grabMapInstance();
    expect(mapInstance.remove).not.toHaveBeenCalled();

    // Spanning bounds steer the component into the fitBounds branch
    const spanningBounds = {
      isValid: vi.fn().mockReturnValue(true),
      getSouthWest: vi.fn().mockReturnValue({ lat: 38.8, lng: -77.2 }),
      getNorthEast: vi.fn().mockReturnValue({ lat: 39.0, lng: -76.9 }),
    };
    vi.mocked(grabGeoJsonLayer().getBounds).mockReturnValue(spanningBounds);

    rerender(React.createElement(GeoJsonBlock, { code: secondValidGeoJson }));

    // The previous map is torn down and a fresh one renders the new payload
    expect(mapInstance.remove).toHaveBeenCalledTimes(1);
    expect(L.map).toHaveBeenCalledTimes(2);
    expect(mapInstance.fitBounds).toHaveBeenCalledWith(spanningBounds, { padding: [20, 20] });
  });
});
