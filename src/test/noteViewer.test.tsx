import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import NoteViewer from '../components/NoteViewer';
import type { Note, NoteAttachment } from '../lib/db';

/**
 * NoteViewer — read-only markdown viewer (ROUND 21 of the coverage campaign).
 *
 * The component is lazy-loaded by src/pages/Index.tsx but is imported directly
 * here, which is equivalent because both resolve to the same module. Every
 * dispatch branch is driven prop-driven with note fixtures:
 *
 *   - segment splitting: markdown / callout (`> [!TYPE]`) / merging,
 *   - code component dispatch: mermaid, geojson, 3dmodel, bpmn fences,
 *     inline code, shiki-highlighted fences and the no-highlighter fallback,
 *   - img/a overrides: attachment resolution (thumbnail vs data), stl/obj
 *     routing to Model3DBlock, missing-attachment placeholders, external and
 *     data-URL links,
 *   - GFM tables: plain cells (checkbox/radio cell syntax, non-string and
 *     empty children) and `||` merged-cell tables pre-processed into raw
 *     HTML (th/td + colspan),
 *   - attachments section: size formatting (B/KB/MB), thumbnails,
 *     referenced vs "(not embedded)", download/open links and the Delete
 *     button's onSave payload (including reference stripping),
 *   - empty-content placeholder.
 *
 * The lazily-loaded block components render for real; their heavy third-party
 * dependencies are replaced with the same per-file mock factories the
 * dedicated component tests use (shiki, mermaid, bpmn-js, leaflet, three).
 */

// ---------------------------------------------------------------------------
// Heavy-dependency mocks (established factories, copied from the block tests)
// ---------------------------------------------------------------------------

// CodeBlock, MermaidBlock and BpmnBlock pull shiki in with a dynamic
// import(); replace it with a deterministic stub. vi.mock is hoisted above
// the component import, so the factory is fed from vi.hoisted state.
const { codeToHtmlMock } = vi.hoisted(() => ({ codeToHtmlMock: vi.fn() }));
vi.mock('shiki', () => ({ codeToHtml: codeToHtmlMock }));

// MermaidBlock imports mermaid statically and even calls mermaid.initialize()
// at module scope, so the mock must be in place before the module loads.
const { initializeMock, renderMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(),
  renderMock: vi.fn(),
}));
vi.mock('mermaid', () => ({
  default: { initialize: initializeMock, render: renderMock },
}));

// BpmnBlock imports the bpmn-js Viewer statically at module scope and calls
// layoutProcess from bpmn-auto-layout inside its viewer effect.
const viewerState = vi.hoisted(() => ({
  created: [] as Array<{
    options: { container: HTMLElement };
    importXML: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }>,
}));
const { layoutProcessMock } = vi.hoisted(() => ({ layoutProcessMock: vi.fn() }));
vi.mock('bpmn-js/lib/Viewer', () => {
  class FakeBpmnViewer {
    options: { container: HTMLElement };
    importXML: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    constructor(options: { container: HTMLElement }) {
      this.options = options;
      this.importXML = vi.fn(() => Promise.resolve());
      this.destroy = vi.fn();
      viewerState.created.push(this);
    }
  }
  return { default: FakeBpmnViewer };
});
vi.mock('bpmn-auto-layout', () => ({ layoutProcess: layoutProcessMock }));

// GeoJsonBlock uses leaflet + the markercluster plugin; the full proxy mock
// is copied from geojson.test.ts.
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

  // Most recent payload handed to L.geoJSON; drives what eachLayer emits.
  let lastGeoJsonData: unknown = null;

  // Stand-in for Leaflet vector layers (polylines, polygons) that the
  // component must add straight to the map instead of the cluster group.
  const makeVectorLayer = () => ({
    addTo: vi.fn().mockReturnThis(),
    bindPopup: vi.fn().mockReturnThis(),
  });

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
    vectorLayers: [] as ReturnType<typeof makeVectorLayer>[],
    eachLayer: vi.fn().mockImplementation((callback: (layer: unknown) => void) => {
      mockGeoJsonLayer.vectorLayers.length = 0;
      const features = collectFeatures(lastGeoJsonData);
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

  // Proxy to return a stub with .extend and standard prototype for any
  // missing leaflet property accessed by plugins.
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

// Model3DBlock uses three.js (WebGLRenderer cannot work in jsdom), the STL/OBJ
// loaders, OrbitControls and file-saver; the partial three mock is copied from
// model3d.test.ts. ResizeObserver needs no override here — the setup.ts stub
// is enough because the viewport never has to resize for these tests.
const hoisted = vi.hoisted(() => {
  const makeMockGeometry = () => ({
    center: vi.fn(),
    computeVertexNormals: vi.fn(),
    computeBoundingBox: vi.fn(),
    computeBoundingSphere: vi.fn(),
    boundingSphere: { radius: 10 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 4, z: 6 } },
    attributes: {} as Record<string, unknown>,
    getAttribute: vi.fn(() => ({ count: 3, getX: () => 1, getY: () => 2, getZ: () => 3 })),
    setAttribute: vi.fn(function (this: { attributes: Record<string, unknown> }, name: string, attr: unknown) {
      this.attributes[name] = attr;
    }),
  });

  return {
    makeMockGeometry,
    materialMode: 'single' as 'single' | 'array',
  };
});

vi.mock('file-saver', () => ({
  saveAs: vi.fn(),
}));

vi.mock('three/examples/jsm/controls/OrbitControls.js', () => {
  return {
    OrbitControls: vi.fn().mockImplementation(() => ({
      update: vi.fn(),
      dispose: vi.fn(),
      rotateLeft: vi.fn(),
      rotateUp: vi.fn(),
      dollyIn: vi.fn(),
      dollyOut: vi.fn(),
      target: { x: 0, y: 0, z: 0, set: vi.fn(), add: vi.fn() },
    })),
  };
});

// Mock STLLoader: every parse call returns a fresh mock geometry.
vi.mock('three/examples/jsm/loaders/STLLoader.js', () => {
  return {
    STLLoader: vi.fn().mockImplementation(() => ({
      parse: vi.fn(() => hoisted.makeMockGeometry()),
    })),
  };
});

// Mock OBJLoader: parse returns a group whose clone produces fresh children,
// including one real mock Mesh (so `instanceof THREE.Mesh` holds) and one
// plain non-mesh node (to exercise the traverse guard).
vi.mock('three/examples/jsm/loaders/OBJLoader.js', async () => {
  const THREE = await import('three');
  const makeObjGroup = () => {
    const meshChild = new THREE.Mesh(
      hoisted.makeMockGeometry() as unknown as THREE.BufferGeometry,
      undefined
    );
    const plainChild = { name: 'group-node' };
    return {
      children: [meshChild, plainChild],
      clone: vi.fn(() => makeObjGroup()),
      traverse: vi.fn((visit: (child: unknown) => void) => {
        visit(meshChild);
        visit(plainChild);
      }),
      rotation: { x: 0, y: 0, z: 0 },
      position: { sub: vi.fn() },
    };
  };
  return {
    OBJLoader: vi.fn().mockImplementation(() => ({
      parse: vi.fn(() => makeObjGroup()),
    })),
  };
});

// Mock three.js: keep the real module (pure JS) and only replace the
// WebGL-touching surface plus the few classes the viewport maths relies on.
vi.mock('three', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();

  const mockWebGLRenderer = vi.fn().mockImplementation(() => ({
    setSize: vi.fn(),
    setPixelRatio: vi.fn(),
    dispose: vi.fn(),
    render: vi.fn(),
    shadowMap: { enabled: false },
    domElement: document.createElement('canvas'),
  }));

  const mockScene = vi.fn().mockImplementation(() => ({
    add: vi.fn(),
    background: { set: vi.fn() },
  }));

  const mockCamera = vi.fn().mockImplementation(() => ({
    position: {
      x: 0,
      y: 0,
      z: 0,
      set(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
      },
      add(v: { x: number; y: number; z: number }) {
        this.x += v.x;
        this.y += v.y;
        this.z += v.z;
        return this;
      },
    },
    up: { x: 0, y: 1, z: 0 },
    lookAt: vi.fn(),
    updateProjectionMatrix: vi.fn(),
    zoom: 1,
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    aspect: 1,
  }));

  // A real constructor (assigns to `this`, returns nothing) so that the
  // component's `instanceof THREE.Mesh` checks pass for created meshes.
  const mockMesh = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    geometry?: unknown,
    material?: unknown
  ) {
    this.geometry = geometry ?? null;
    this.material = material ?? null;
    this.castShadow = false;
    this.receiveShadow = false;
    this.rotation = { x: 0, y: 0, z: 0 };
    this.position = { x: 0, y: 0, z: 0 };
  });

  const makeMaterial = () => ({ dispose: vi.fn() });

  return {
    ...actual,
    WebGLRenderer: mockWebGLRenderer,
    Scene: mockScene,
    PerspectiveCamera: mockCamera,
    OrthographicCamera: mockCamera,
    Mesh: mockMesh,
    PlaneGeometry: vi.fn().mockImplementation(() => ({})),
    MeshBasicMaterial: vi.fn().mockImplementation(() => makeMaterial()),
    MeshStandardMaterial: vi.fn().mockImplementation(() => {
      const material = makeMaterial();
      return hoisted.materialMode === 'array' ? [material] : material;
    }),
    MeshNormalMaterial: vi.fn().mockImplementation(() => makeMaterial()),
    AmbientLight: vi.fn().mockImplementation(() => ({})),
    DirectionalLight: vi.fn().mockImplementation(() => ({
      position: { set: vi.fn().mockReturnThis(), normalize: vi.fn().mockReturnThis() }
    })),
    Vector3: class {
      x = 0; y = 0; z = 0;
      constructor(x = 0, y = 0, z = 0) {
        this.x = x; this.y = y; this.z = z;
      }
      set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
      add(v: { x: number; y: number; z: number }) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
      sub(v: { x: number; y: number; z: number }) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
      normalize() { return this; }
      subVectors() { return this; }
      addScaledVector() { return this; }
      crossVectors() { return this; }
    },
    Box3: class {
      setFromObject() { return this; }
      getCenter(v: { set: (x: number, y: number, z: number) => void }) { v.set(0, 0, 0); return v; }
      getBoundingSphere(s: { radius: number }) { s.radius = 10; return s; }
    },
    Sphere: class {
      radius = 10;
    },
    Color: class {
      set() {}
    },
    TextureLoader: vi.fn().mockImplementation(() => ({
      load: vi.fn().mockImplementation((url: string, onLoad: (t: unknown) => void) => {
        onLoad({ wrapS: 0, wrapT: 0 });
      }),
    })),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STL_DATA = 'data:model/stl;base64,Q09MT1I9AAAAAAAAAAAAAAAAAAAAAAA=';
const OBJ_DATA = 'data:model/obj;base64,PD89PG9iaj4=';
const PNG_THUMBNAIL = 'data:image/png;base64,thumbnail';
const PNG_DATA = 'data:image/png;base64,original';

const stlAttachment: NoteAttachment = {
  id: 'att-stl-001',
  name: 'part.stl',
  type: 'model/stl',
  size: 7684,
  data: STL_DATA,
};

const objAttachment: NoteAttachment = {
  id: 'att-obj-001',
  name: 'mesh.obj',
  type: 'model/obj',
  size: 2048,
  data: OBJ_DATA,
};

const photoAttachment: NoteAttachment = {
  id: 'photo-uuid',
  name: 'photo.png',
  type: 'image/png',
  size: 500,
  data: PNG_DATA,
  thumbnail: PNG_THUMBNAIL,
};

const pdfAttachment: NoteAttachment = {
  id: 'pdf-uuid',
  name: 'spec.pdf',
  type: 'application/pdf',
  size: 2048,
  data: 'data:application/pdf;base64,AAAA',
};

const binAttachment: NoteAttachment = {
  id: 'bin-uuid',
  name: 'big.bin',
  type: '',
  size: 3 * 1024 * 1024,
  data: 'data:application/octet-stream;base64,BBBB',
};

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: 1,
    title: 'Test note',
    content: '',
    tags: [],
    category: 'General',
    attachments: [],
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    editDates: [],
    pinned: false,
    ...overrides,
  };
}

const SHIKI_HTML = '<span data-testid="shiki-note-viewer">highlighted</span>';

const BASIC_MARKDOWN = [
  '# Release plan',
  '',
  'Body with **bold**, *italic*, [external](https://example.com) and `inline code`.',
  '',
  '![dot](data:image/png;base64,AAAA)',
  '',
  '![](data:image/png;base64,BBBB)',
  '',
  '```js',
  'const answer = 42',
  '```',
].join('\n');

const CALLOUT_MARKDOWN = [
  'Intro line one',
  'intro line two',
  '',
  '> [!WARNING]',
  '> Watch out for **traps**',
  '> and see [the docs](https://example.com/docs)',
  '> plus ![thumb](attachment:photo.png) and ![dot](data:image/png;base64,AAAA)',
  '',
  'Outro line',
].join('\n');

const TABLE_MARKDOWN = [
  '| Alpha | Beta |',
  '| --- | --- |',
  '| plain | **bold cell** |',
  '| done [x] | pick (x) |',
  '| skip [ ] | none ( ) |',
  '| run[x]now | |',
  '',
  '| span || right |',
  '| --- | --- |',
  '| a || b |',
  '',
  '| a || b |',
  '| c | d |',
  '',
  '| x || y |',
].join('\n');

const GEOJSON_BODY = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'HQ' },
      geometry: { type: 'Point', coordinates: [-77.091, 38.88] },
    },
  ],
});

// Has the Diagram Interchange section, so BpmnBlock skips bpmn-auto-layout.
const DIAGRAM_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" targetNamespace="http://bpmn.io/schema/bpmn">' +
  '<bpmn:process id="Process_1"><bpmn:startEvent id="Start_1"/></bpmn:process>' +
  '<bpmndi:BPMNDiagram id="Diagram_1">' +
  '<bpmndi:BPMNPlane id="Plane_1" bpmnElement="Process_1"/>' +
  '</bpmndi:BPMNDiagram>' +
  '</bpmn:definitions>';

const fence = (language: string, body: string) => ['```' + language, body, '```'].join('\n');

beforeEach(() => {
  codeToHtmlMock.mockReset();
  codeToHtmlMock.mockResolvedValue(SHIKI_HTML);
  initializeMock.mockClear();
  renderMock.mockClear();
  renderMock.mockImplementation((id: string) => Promise.resolve({ svg: `<svg id="${id}"><g/></svg>` }));
  layoutProcessMock.mockReset();
  layoutProcessMock.mockResolvedValue('<bpmn:definitions/>');
  viewerState.created.length = 0;
});

describe('NoteViewer component', () => {
  describe('markdown dispatch and rendering', () => {
    it('renders headings, inline formatting, links, data-url images and shiki-highlighted fences', async () => {
      const { container } = render(
        <NoteViewer note={makeNote({ content: BASIC_MARKDOWN })} />,
      );

      expect(screen.getByText('Viewing')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Release plan' })).toBeInTheDocument();
      expect(container.querySelector('strong')?.textContent).toBe('bold');
      expect(container.querySelector('em')?.textContent).toBe('italic');

      const externalLink = screen.getByText('external').closest('a') as HTMLAnchorElement;
      expect(externalLink).toHaveAttribute('href', 'https://example.com');
      expect(externalLink).toHaveAttribute('target', '_blank');
      expect(externalLink).toHaveAttribute('rel', 'noreferrer');

      const inlineCode = screen.getByText('inline code');
      expect(inlineCode.tagName).toBe('CODE');
      expect(inlineCode).toHaveClass('rounded', 'bg-muted');

      const dataImage = screen.getByAltText('dot') as HTMLImageElement;
      expect(dataImage).toHaveAttribute('src', 'data:image/png;base64,AAAA');
      expect(dataImage).toHaveAttribute('loading', 'lazy');

      // An image without alt text falls back to an empty string.
      const emptyAltImage = container.querySelector('img[alt=""]') as HTMLImageElement;
      expect(emptyAltImage).toHaveAttribute('src', 'data:image/png;base64,BBBB');

      // The ```js fence is routed to the real CodeBlock, which highlights
      // through the mocked shiki.
      await waitFor(() => {
        expect(container.querySelector('.shiki-wrapper')).not.toBeNull();
      });
      expect(container.querySelector('.shiki-wrapper')?.innerHTML).toBe(SHIKI_HTML);
      expect(codeToHtmlMock).toHaveBeenCalledWith('const answer = 42', {
        lang: 'js',
        theme: 'github-dark',
      });
    });

    it('falls back to a plain pre/code when the note has no code blocks flag', () => {
      codeToHtmlMock.mockClear();
      const { container } = render(
        <NoteViewer note={makeNote({ content: fence('js', 'const x = 1'), hasCodeBlocks: false })} />,
      );

      const code = container.querySelector('pre code');
      expect(code).not.toBeNull();
      expect(code?.className).toContain('language-js');
      // remark keeps the fence's trailing newline in the code text.
      expect(code?.textContent).toBe('const x = 1\n');
      expect(codeToHtmlMock).not.toHaveBeenCalled();
      expect(container.querySelector('.shiki-wrapper')).toBeNull();
    });

    it('renders placeholders for unresolvable attachment references', () => {
      render(
        <NoteViewer
          note={makeNote({
            content: [
              '![ghost](attachment:nope.png)',
              '',
              '[ghost file](attachment:nope.bin)',
              '',
              '[no href]()',
            ].join('\n'),
          })}
        />,
      );

      expect(screen.getByText('[missing image]')).toBeInTheDocument();
      // The broken attachment link and the href-less link both degrade to the
      // missing-attachment placeholder.
      expect(screen.getAllByText('[missing attachment]')).toHaveLength(2);
    });
  });

  describe('special block dispatch', () => {
    it('renders mermaid fences through MermaidBlock', async () => {
      const { container } = render(
        <NoteViewer note={makeNote({ content: fence('mermaid', 'graph TD\n  A --> B') })} />,
      );

      // MermaidBlock is React.lazy and mounts asynchronously, and the mocked
      // render resolves as a promise. A bare `querySelector('svg')` can match
      // the toolbar's lucide icon before the diagram renders, leaving
      // `renderMock.mock.calls[0]` undefined (the flaky-failure source). So
      // wait for the mock to actually be called with the diagram source.
      await waitFor(() => {
        expect(renderMock.mock.calls[0]?.[1]).toBe('graph TD\n  A --> B');
      });
      expect(container.querySelector('.mermaid-diagram')).not.toBeNull();
      expect(container.querySelector('.mermaid-diagram svg')).not.toBeNull();
      expect(screen.getByText('Diagram Preview')).toBeInTheDocument();
      expect(initializeMock).toHaveBeenCalled();
    });

    it('renders geojson fences through GeoJsonBlock', async () => {
      render(
        <NoteViewer note={makeNote({ content: fence('geojson', GEOJSON_BODY) })} />,
      );

      await screen.findByText('Map Preview');
      expect(screen.queryByText('GeoJSON Error')).not.toBeInTheDocument();
    });

    it('renders 3dmodel fences through Model3DBlock', async () => {
      const { container } = render(
        <NoteViewer
          note={makeNote({
            content: fence('3dmodel', 'attachment:part.stl'),
            attachments: [stlAttachment],
          })}
        />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
      });
      // The block header names the resolved attachment.
      expect(container.textContent).toContain('part.stl');
    });

    it('renders bpmn fences through BpmnBlock', async () => {
      render(<NoteViewer note={makeNote({ content: fence('bpmn', DIAGRAM_XML) })} />);

      // findByText waits out the lazy chunk load before the block mounts.
      await screen.findByText('bpmn');
      await waitFor(() => {
        expect(screen.queryByText('Loading diagram…')).not.toBeInTheDocument();
      });
      expect(viewerState.created).toHaveLength(1);
      expect(viewerState.created[0].importXML).toHaveBeenCalledWith(DIAGRAM_XML);
    });

    it('routes image and link references to stl/obj attachments to Model3DBlock', async () => {
      const { container } = render(
        <NoteViewer
          note={makeNote({
            content: [
              '![part](attachment:part.stl)',
              '',
              '[download mesh](attachment:mesh.obj)',
              '',
              '![mesh](attachment:mesh.obj)',
              '',
              '[part link](attachment:part.stl)',
            ].join('\n'),
            attachments: [stlAttachment, objAttachment],
          })}
        />,
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
      });
      expect(container.textContent).toContain('part.stl');
      expect(container.textContent).toContain('mesh.obj');
      expect(container.textContent).not.toContain('[missing image]');
      // Inline model refs must not leave a <div> inside a <p> (Model3DBlock
      // itself contains no <p>, so this covers the whole subtree).
      for (const paragraph of container.querySelectorAll("p")) {
        expect(paragraph.querySelector("div")).toBeNull();
      }
    });
  });

  describe('callouts', () => {
    it('splits callout segments out of the markdown flow and renders their body', () => {
      const { container } = render(
        <NoteViewer note={makeNote({ content: CALLOUT_MARKDOWN })} />,
      );

      const callout = container.querySelector('.callout.callout-warning');
      expect(callout).not.toBeNull();
      expect(within(callout as HTMLElement).getByText('Warning')).toBeInTheDocument();
      expect((callout as HTMLElement).textContent).toContain('Watch out for');
      expect((callout as HTMLElement).textContent).toContain('plus');
      expect((callout as HTMLElement).querySelector('strong')?.textContent).toBe('traps');
      // Plain https URLs pass the callout's urlTransform untouched.
      const calloutLink = within(callout as HTMLElement).getByText('the docs').closest('a') as HTMLAnchorElement;
      expect(calloutLink).toHaveAttribute('href', 'https://example.com/docs');
      // Inside the callout, the unresolved attachment reference degrades to
      // the missing-image placeholder while the data-url image renders.
      expect(within(callout as HTMLElement).getByText('[missing image]')).toBeInTheDocument();
      expect((callout as HTMLElement).querySelector('img[alt="dot"]')).not.toBeNull();

      // Surrounding markdown still renders outside the callout.
      expect(screen.getByText(/Intro line one/)).toBeInTheDocument();
      expect(screen.getByText(/Outro line/)).toBeInTheDocument();
    });
  });

  describe('tables', () => {
    it('transforms checkbox/radio cell syntax, bold and empty cells; merges `||` cells into raw HTML', () => {
      const { container } = render(
        <NoteViewer
          note={makeNote({
            content: [
              '| Alpha | Beta |',
              '| --- | --- |',
              '| plain | **bold cell** |',
              '| done [x] | pick (x) |',
              '| skip [ ] | none ( ) |',
              '| run[x]now | |',
              '',
              '| span || right |',
              '| --- | --- |',
              '| a || b |',
              '',
              '| a || b |',
              '| c | d |',
              '',
              '| x || y |',
            ].join('\n'),
          })}
        />,
      );

      // Plain GFM table: cells keep their custom checkbox/radio transforms.
      // Three checkboxes: `done [x]`, `skip [ ]` and `run[x]now`.
      const checkboxes = container.querySelectorAll('input[type="checkbox"]');
      expect(checkboxes).toHaveLength(3);
      expect(checkboxes[0]).toBeChecked();
      expect(checkboxes[0]).toHaveProperty('readOnly', true);
      expect(checkboxes[1]).not.toBeChecked();
      expect(checkboxes[2]).toBeChecked();
      const radios = container.querySelectorAll('input[type="radio"]');
      expect(radios).toHaveLength(2);
      expect(radios[0]).toBeChecked();
      expect(radios[1]).not.toBeChecked();

      // Non-string (bold) and empty cells pass through untouched.
      expect(container.querySelector('td strong')?.textContent).toBe('bold cell');
      const emptyCells = Array.from(container.querySelectorAll('td')).filter(
        (td) => td.textContent === '',
      );
      expect(emptyCells.length).toBeGreaterThan(0);

      // The `||` table with a separator row became a raw HTML table with
      // merged header/body cells.
      expect(container.querySelector('th[colspan="2"]')?.textContent).toBe('span');
      expect(container.querySelector('td[colspan="2"]')?.textContent).toBe('a');
      expect(container.querySelector('table')).not.toBeNull();

      // Without a separator row (or with a single row) the lines fall back to
      // ordinary markdown and keep their literal pipes.
      expect(container.textContent).toContain('| a || b |');
      expect(container.textContent).toContain('| c | d |');
      expect(container.textContent).toContain('| x || y |');
    });
  });

  describe('attachments section', () => {
    it('lists metadata, size formatting, thumbnails and embedded state', () => {
      const { container } = render(
        <NoteViewer
          note={makeNote({
            content: [
              '# Photos',
              '',
              '![photo](attachment:photo.png)',
              '',
              '[data dump](attachment:bin-uuid)',
            ].join('\n'),
            attachments: [photoAttachment, pdfAttachment, binAttachment],
          })}
        />,
      );

      expect(screen.getByText('Attachments')).toBeInTheDocument();

      const photoRow = screen.getByText('photo.png').closest('.bg-card') as HTMLElement;
      const pdfRow = screen.getByText('spec.pdf').closest('.bg-card') as HTMLElement;
      const binRow = screen.getByText('big.bin').closest('.bg-card') as HTMLElement;

      expect(photoRow.textContent).toContain('image/png · 500 B');
      expect(pdfRow.textContent).toContain('application/pdf · 2.0 KB');
      expect(binRow.textContent).toContain('file · 3.0 MB');

      // Referenced by name and by id — only the unreferenced one is flagged.
      expect(within(pdfRow).getByText('(not embedded)')).toBeInTheDocument();
      expect(within(photoRow).queryByText('(not embedded)')).not.toBeInTheDocument();
      expect(within(binRow).queryByText('(not embedded)')).not.toBeInTheDocument();

      const download = within(photoRow).getByText('Download').closest('a') as HTMLAnchorElement;
      expect(download).toHaveAttribute('href', PNG_DATA);
      expect(download).toHaveAttribute('download', 'photo.png');
      const open = within(photoRow).getByText('Open').closest('a') as HTMLAnchorElement;
      expect(open).toHaveAttribute('target', '_blank');
      expect(open).toHaveAttribute('rel', 'noreferrer');

      // No onSave: the Delete action is not offered.
      expect(within(photoRow).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();

      // The embedded markdown image resolves to the attachment thumbnail, and
      // the attachment card preview uses the thumbnail as well. Non-image
      // attachments get no preview.
      const embedded = screen.getByAltText('photo') as HTMLImageElement;
      expect(embedded).toHaveAttribute('src', PNG_THUMBNAIL);
      const preview = container.querySelector('img[alt="photo.png"]') as HTMLImageElement;
      expect(preview).toHaveAttribute('src', PNG_THUMBNAIL);
      expect(container.querySelector('img[alt="spec.pdf"]')).toBeNull();
      expect(container.querySelector('img[alt="big.bin"]')).toBeNull();

      // The data dump link resolves to the attachment data and downloads it
      // inline (no target/rel for data: URLs).
      const binLink = screen.getByText('data dump').closest('a') as HTMLAnchorElement;
      expect(binLink).toHaveAttribute('href', binAttachment.data);
      expect(binLink).toHaveAttribute('download', 'big.bin');
      expect(binLink).not.toHaveAttribute('target');
    });

    it('deletes an attachment, strips its references from the content and saves', () => {
      const onSave = vi.fn();
      const originalContent = ['# Doc', '', '![photo](attachment:photo.png)', '', 'Tail section'].join('\n');
      render(
        <NoteViewer
          note={makeNote({ content: originalContent, attachments: [photoAttachment, pdfAttachment] })}
          onSave={onSave}
        />,
      );

      const pdfRow = screen.getByText('spec.pdf').closest('.bg-card') as HTMLElement;
      const photoRow = screen.getByText('photo.png').closest('.bg-card') as HTMLElement;

      // Deleting the unreferenced pdf leaves the content untouched.
      fireEvent.click(within(pdfRow).getByRole('button', { name: 'Delete' }));
      expect(onSave).toHaveBeenCalledTimes(1);
      expect(onSave.mock.calls[0][0]).toEqual({
        attachments: [photoAttachment],
        content: originalContent,
      });

      // Deleting the embedded photo strips the reference line.
      fireEvent.click(within(photoRow).getByRole('button', { name: 'Delete' }));
      expect(onSave).toHaveBeenCalledTimes(2);
      expect(onSave.mock.calls[1][0]).toEqual({
        attachments: [pdfAttachment],
        content: '# Doc\n\nTail section',
      });
    });
  });

  describe('empty state', () => {
    it('shows the empty placeholder for whitespace-only content', () => {
      render(<NoteViewer note={makeNote({ content: '   ' })} />);
      expect(screen.getByText('Empty note')).toBeInTheDocument();
    });
  });
});