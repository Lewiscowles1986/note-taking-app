import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import type { GeoJsonObject } from 'geojson';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { Map as MapIcon, Code as CodeIcon, AlertCircle } from 'lucide-react';
import CodeBlock from './CodeBlock';

// Fix Leaflet default marker icon resolution under Vite bundler
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as L.Icon.Default & { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: markerIcon,
  iconRetinaUrl: markerIcon2x,
  shadowUrl: markerShadow,
});

interface GeoJsonBlockProps {
  code: string;
}

export default function GeoJsonBlock({ code }: GeoJsonBlockProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [activeTab, setActiveTab] = useState<'preview' | 'code'>('preview');
  const [error, setError] = useState<string | null>(null);
  const [parsedData, setParsedData] = useState<GeoJsonObject | null>(null);

  // Validate and parse GeoJSON payload
  useEffect(() => {
    try {
      const data = JSON.parse(code);
      const validTypes = [
        'Point', 'MultiPoint', 'LineString', 'MultiLineString',
        'Polygon', 'MultiPolygon', 'GeometryCollection',
        'Feature', 'FeatureCollection'
      ];
      if (!data || typeof data !== 'object' || !validTypes.includes(data.type)) {
        throw new Error('Invalid GeoJSON: Object must have a valid GeoJSON "type" field.');
      }
      setParsedData(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid JSON format');
      setParsedData(null);
    }
  }, [code]);

  // Leaflet map initialization and layer rendering
  useEffect(() => {
    if (activeTab !== 'preview' || !parsedData || !mapContainerRef.current) {
      return;
    }

    let mapInstance: L.Map | null = null;
    let timer: NodeJS.Timeout | null = null;

    try {
      // Create a fresh map instance, disabling scrollWheelZoom to prevent hijacking page scrolls
      mapInstance = L.map(mapContainerRef.current, {
        scrollWheelZoom: false,
      }).setView([0, 0], 2);
      mapRef.current = mapInstance;

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(mapInstance);

      // Initialize Leaflet Marker Cluster Group
      const markerClusterGroup = L.markerClusterGroup();

      // Add the new GeoJSON layer to map (not bound to map directly)
      const geoJsonLayer = L.geoJSON(parsedData, {
        onEachFeature: (feature, layer) => {
          // Format properties in a clean, scrollable tabular layout inside a popup
          if (feature.properties && Object.keys(feature.properties).length > 0) {
            const rows = Object.entries(feature.properties)
              .map(([key, val]) => `
                <tr style="border-bottom: 1px solid #e2e8f0; font-family: monospace; font-size: 11px;">
                  <td style="padding: 4px 8px 4px 0; font-weight: 600; color: #64748b; white-space: nowrap;">${key}</td>
                  <td style="padding: 4px 0; color: #0f172a; word-break: break-all;">${typeof val === 'object' ? JSON.stringify(val) : val}</td>
                </tr>
              `)
              .join('');

            const popupContent = `
              <div style="max-height: 200px; overflow-y: auto; padding: 4px; min-width: 180px;">
                <table style="width: 100%; border-collapse: collapse; text-align: left;">
                  <tbody>
                    ${rows}
                  </tbody>
                </table>
              </div>
            `;
            layer.bindPopup(popupContent);
          }
        }
      });

      // Separate Point markers from Polyline/Polygon paths for clustering
      geoJsonLayer.eachLayer((layer) => {
        if (layer instanceof L.Marker) {
          markerClusterGroup.addLayer(layer);
        } else {
          layer.addTo(mapInstance!);
        }
      });

      // Add the cluster group of markers to the map
      mapInstance.addLayer(markerClusterGroup);

      // Adjust boundaries to fit features
      const bounds = geoJsonLayer.getBounds();
      if (bounds.isValid()) {
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        if (sw.lat === ne.lat && sw.lng === ne.lng) {
          // If it's a single point, set map view with default zoom level
          mapInstance.setView(sw, 13);
        } else {
          mapInstance.fitBounds(bounds, { padding: [20, 20] });
        }
      }

      // Leaflet map size correction when container updates
      timer = setTimeout(() => {
        if (mapInstance) {
          mapInstance.invalidateSize();
        }
      }, 50);

    } catch (err) {
      console.error('Failed to parse or add GeoJSON layer:', err);
      setError(err instanceof Error ? err.message : 'Error rendering GeoJSON layers');
    }

    // Clean up map instance when switching tabs, when parsedData changes, or when component unmounts
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (mapInstance) {
        mapInstance.remove();
        if (mapRef.current === mapInstance) {
          mapRef.current = null;
        }
      }
    };
  }, [activeTab, parsedData]);

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive p-4 rounded-md border border-destructive/20 my-3 flex items-start gap-3">
        <AlertCircle className="shrink-0 mt-0.5" size={16} />
        <div>
          <div className="font-semibold text-sm">GeoJSON Error</div>
          <div className="text-xs font-mono mt-1 whitespace-pre-wrap">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative my-3 overflow-hidden rounded-md border border-border bg-card">
      {/* Header Tabs */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#24292e]">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-white/50">geojson</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab('preview')}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors ${
              activeTab === 'preview'
                ? 'bg-white/10 text-white font-medium'
                : 'text-white/60 hover:text-white/95'
            }`}
          >
            <MapIcon size={12} />
            Map Preview
          </button>
          <button
            onClick={() => setActiveTab('code')}
            className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors ${
              activeTab === 'code'
                ? 'bg-white/10 text-white font-medium'
                : 'text-white/60 hover:text-white/95'
            }`}
          >
            <CodeIcon size={12} />
            Code
          </button>
        </div>
      </div>

      {/* Content Container */}
      {activeTab === 'preview' ? (
        <div className="relative w-full h-[400px]">
          <div
            ref={mapContainerRef}
            className="w-full h-full bg-slate-900 z-0"
          />
        </div>
      ) : (
        <div className="w-full select-text border-t border-border [&_>div]:my-0 [&_>div]:border-0 [&_>div]:rounded-none">
          <CodeBlock code={code} language="json" />
        </div>
      )}
    </div>
  );
}
