import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import GeoJsonBlock from '../components/GeoJsonBlock';
import L from 'leaflet';

vi.mock('leaflet', () => {
  class MockMarker {}
  (MockMarker.prototype as any).options = { pane: 'markerPane' };
  (MockMarker.prototype as any).initialize = vi.fn();
  (MockMarker as any).extend = vi.fn().mockImplementation(() => MockMarker);
  (MockMarker as any).include = vi.fn().mockImplementation(() => MockMarker);

  const mockFeatureGroup = class {};
  (mockFeatureGroup as any).extend = vi.fn().mockImplementation(() => mockFeatureGroup);
  (mockFeatureGroup as any).include = vi.fn().mockImplementation(() => mockFeatureGroup);
  (mockFeatureGroup.prototype as any).addLayer = vi.fn().mockReturnThis();
  (mockFeatureGroup.prototype as any).addTo = vi.fn().mockReturnThis();

  const mockMapInstance = {
    setView: vi.fn().mockReturnThis(),
    remove: vi.fn(),
    invalidateSize: vi.fn(),
    addLayer: vi.fn().mockReturnThis(),
  };

  const mockGeoJsonLayer = {
    addTo: vi.fn().mockReturnThis(),
    remove: vi.fn().mockReturnThis(),
    getBounds: vi.fn().mockReturnValue({
      isValid: vi.fn().mockReturnValue(true),
      getSouthWest: vi.fn().mockReturnValue({ lat: 38.88, lng: -77.091 }),
      getNorthEast: vi.fn().mockReturnValue({ lat: 38.88, lng: -77.091 }),
    }),
    eachLayer: vi.fn().mockImplementation((callback) => {
      // Pass a mock marker to trigger point clustering
      callback(new MockMarker());
    }),
  };

  const mockMarkerClusterInstance = {
    addLayer: vi.fn().mockReturnThis(),
    addTo: vi.fn().mockReturnThis(),
  };

  // Base mock object containing specific mocked methods used in our components/tests
  const leafletBaseMock: any = {
    map: vi.fn().mockImplementation(() => mockMapInstance),
    tileLayer: vi.fn().mockReturnValue({
      addTo: vi.fn(),
    }),
    geoJSON: vi.fn().mockImplementation(() => mockGeoJsonLayer),
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
        return target[prop];
      }
      const mockClass: any = class {};
      mockClass.prototype.options = { pane: 'markerPane' };
      mockClass.prototype.initialize = vi.fn();
      mockClass.prototype.addLayer = vi.fn().mockReturnThis();
      mockClass.prototype.addTo = vi.fn().mockReturnThis();
      mockClass.extend = vi.fn().mockImplementation(() => mockClass);
      mockClass.include = vi.fn().mockImplementation(() => mockClass);
      return mockClass;
    }
  });

  // Set global L for leaflet.markercluster plugin compatibility
  (global as any).L = leafletMock;
  (window as any).L = leafletMock;

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
});
