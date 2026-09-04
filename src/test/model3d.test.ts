import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import Model3DBlock from '../components/Model3DBlock';
import { saveAs } from 'file-saver';
import type { Note, NoteAttachment } from '@/lib/db';

// Shared state for the mock factories below (evaluated before imports).
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
    resizeObserverInstances: [] as Array<{
      callback: ResizeObserverCallback;
      observe: Mock;
      unobserve: Mock;
      disconnect: Mock;
    }>,
    materialMode: 'single' as 'single' | 'array',
  };
});

// Mock file-saver
vi.mock('file-saver', () => ({
  saveAs: vi.fn(),
}));

// Mock ResizeObserver globally for headless jsdom tests; capture instances so
// tests can drive the observer callback manually.
global.ResizeObserver = vi.fn().mockImplementation((callback: ResizeObserverCallback) => {
  const instance = {
    callback,
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  };
  hoisted.resizeObserverInstances.push(instance);
  return instance;
});

// Mock OrbitControls
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

// Mock three.js
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
      // Simulate meshes carrying material arrays (as multi-material OBJ files do).
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
      subVectors(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
        this.x = a.x - b.x;
        this.y = a.y - b.y;
        this.z = a.z - b.z;
        return this;
      }
      addScaledVector(v: { x: number; y: number; z: number }, s: number) {
        this.x += v.x * s;
        this.y += v.y * s;
        this.z += v.z * s;
        return this;
      }
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
      load: vi.fn().mockImplementation((url, onLoad) => {
        onLoad({ wrapS: 0, wrapT: 0 });
      }),
    })),
  };
});

describe('Model3DBlock component', () => {
  const mockNote: Note = {
    id: 1,
    title: 'Test Note',
    content: '',
    tags: [],
    category: '',
    attachments: [
      {
        id: 'clip-uuid',
        name: 'clip.stl',
        type: 'model/stl',
        size: 7684,
        data: 'data:model/stl;base64,Q09MT1I9AAAAAAAAAAAAAAAAAAAAAAA=',
      },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
    editDates: [],
    pinned: false,
  };

  const objAttachment: NoteAttachment = {
    id: 'obj-uuid',
    name: 'model.obj',
    type: 'model/obj',
    size: 2048,
    data: 'data:model/obj;base64,PD89PG9iaj4=',
  };

  const texAttachment: NoteAttachment = {
    id: 'tex-uuid',
    name: 'tex.png',
    type: 'image/png',
    size: 512,
    data: 'data:image/png;base64,AAAA',
  };

  const noteWith = (...attachments: NoteAttachment[]): Note => ({
    ...mockNote,
    attachments: [...mockNote.attachments, ...attachments],
  });

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resizeObserverInstances.length = 0;
    hoisted.materialMode = 'single';
    // Mock global fetch to handle data URL decoding or remote mock fetches
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
  });

  function renderModel(code: string, note: Note = mockNote, language = 'stl') {
    return render(React.createElement(Model3DBlock, { code, language, note }));
  }

  async function waitForModelReady() {
    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });
  }

  function lastInstance(constructorFn: unknown): Record<string, unknown> {
    const results = (constructorFn as Mock).mock.results;
    for (let i = results.length - 1; i >= 0; i -= 1) {
      if (results[i].type === 'return') return results[i].value as Record<string, unknown>;
    }
    throw new Error('Expected mock constructor to have produced an instance');
  }

  interface MockRendererShape {
    setSize: Mock;
    setPixelRatio: Mock;
    dispose: Mock;
    render: Mock;
    domElement: HTMLCanvasElement;
  }

  interface MockControlsShape {
    update: Mock;
    dispose: Mock;
    rotateLeft: Mock;
    rotateUp: Mock;
    dollyIn: Mock;
    dollyOut: Mock;
    target: { set: Mock; add: Mock };
    autoRotate: boolean;
  }

  const lastRenderer = () =>
    lastInstance(THREE.WebGLRenderer) as unknown as MockRendererShape;
  const lastControls = () =>
    lastInstance(OrbitControls) as unknown as MockControlsShape;

  function callCount(fn: unknown): number {
    return (fn as Mock).mock.calls.length;
  }

  function fireResize(width: number, height: number): void {
    for (const instance of hoisted.resizeObserverInstances) {
      instance.callback(
        [{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
        instance as unknown as ResizeObserver
      );
    }
  }

  it('renders loading placeholder initially', () => {
    render(
      React.createElement(Model3DBlock, {
        code: 'attachment:clip.stl',
        language: 'stl',
        note: mockNote,
      })
    );
    expect(screen.getByText('Loading 3D asset data...')).toBeInTheDocument();
  });

  it('renders model name and size in header after loading', async () => {
    render(
      React.createElement(Model3DBlock, {
        code: 'attachment:clip.stl',
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('clip.stl')).toBeInTheDocument();
    expect(screen.getByText('7.5 KB')).toBeInTheDocument();
  });

  it('provides rendering mode selection buttons (Solid, Surface Angle, Wireframe)', async () => {
    render(
      React.createElement(Model3DBlock, {
        code: 'attachment:clip.stl',
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Solid')).toBeInTheDocument();
    expect(screen.getByText('Surface Angle')).toBeInTheDocument();
    expect(screen.getByText('Wireframe')).toBeInTheDocument();
  });

  it('switches rendering mode when button is clicked', async () => {
    render(
      React.createElement(Model3DBlock, {
        code: 'attachment:clip.stl',
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    const wireframeButton = screen.getByText('Wireframe');
    fireEvent.click(wireframeButton);

    // Clicking should update local render state and rebuild view
    expect(wireframeButton).toHaveClass('bg-slate-900');
  });

  it('triggers file-saver download when download button is clicked', async () => {
    render(
      React.createElement(Model3DBlock, {
        code: 'attachment:clip.stl',
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    const downloadButton = screen.getByText('Download');
    fireEvent.click(downloadButton);

    expect(saveAs).toHaveBeenCalled();
  });

  it('supports single viewport by default', async () => {
    render(
      React.createElement(Model3DBlock, {
        code: 'attachment:clip.stl',
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    // Check that we render exactly one sub viewport with default name
    expect(screen.getByText('Default')).toBeInTheDocument();
  });

  it('supports multiple viewports from frontmatter config', async () => {
    const multiViewportCode = `---
viewports:
  - name: Front View
    camera: [0, 0, 30]
    mode: Solid
  - name: Top View
    camera: [0, 30, 0]
    mode: Wireframe
---
attachment:clip.stl`;

    render(
      React.createElement(Model3DBlock, {
        code: multiViewportCode,
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Front View')).toBeInTheDocument();
    expect(screen.getByText('Top View')).toBeInTheDocument();
    expect(screen.queryByText('Default')).not.toBeInTheDocument();

    // Front View has active controls initially
    expect(screen.getAllByTitle('Tilt Up')).toHaveLength(1);

    // Click Top View component container to switch active focus
    const topViewContainer = screen.getByText('Top View').closest('.cursor-pointer')!;
    fireEvent.click(topViewContainer);

    // Controls are now active in Top View (still exactly 1 overlay rendered)
    expect(screen.getAllByTitle('Tilt Up')).toHaveLength(1);
  });

  it('displays error notice when fetching or parsing fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

    render(
      React.createElement(Model3DBlock, {
        code: 'url:https://invalid-host/model.stl',
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('3D Model Rendering Error')).toBeInTheDocument();
    expect(screen.getByText(/Network offline/)).toBeInTheDocument();
  });

  it('supports direct base64 URL links', async () => {
    render(
      React.createElement(Model3DBlock, {
        code: 'url:data:model/stl;base64,Q09MT1I9AAAAAAAAAAAAAAAAAAAAAAA=',
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('model.stl')).toBeInTheDocument();
  });

  it('hides controls when they are disabled via frontmatter', async () => {
    const disabledCode = `---
pan: false
zoom: false
drag: false
---
attachment:clip.stl`;

    render(
      React.createElement(Model3DBlock, {
        code: disabledCode,
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    expect(screen.queryByTitle('Tilt Up')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Pan Up')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Zoom In')).not.toBeInTheDocument();
    expect(screen.queryByTitle('Reset Camera View')).not.toBeInTheDocument();
  });

  it('supports orthographic camera projection', async () => {
    const orthoCode = `---
viewports:
  - name: Top View
    camera: [0, 30, 0]
    projection: orthographic
---
attachment:clip.stl`;

    render(
      React.createElement(Model3DBlock, {
        code: orthoCode,
        language: 'stl',
        note: mockNote,
      })
    );

    await waitFor(() => {
      expect(screen.queryByText('Loading 3D asset data...')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Top View')).toBeInTheDocument();
  });

  describe('frontmatter parsing', () => {
    it('parses booleans and malformed array values and exits viewport list at a root key', async () => {
      renderModel(`---
grab: true
mode: [oops]
viewports:
  - name: Front
texture: attachment:missing.png
---
attachment:clip.stl`);

      await waitForModelReady();

      expect(screen.getByText('Front')).toBeInTheDocument();
      // The viewport list overrides the malformed top-level mode, so the
      // default "Solid" mode stays active.
      expect(screen.getByText('Solid')).toHaveClass('bg-slate-900');
    });

    it('logs and recovers when the viewports block contains invalid JSON', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        renderModel(`---
viewports:
  - name: Broken
    camera: [bad
---
attachment:clip.stl`);

        await waitForModelReady();

        expect(errorSpy).toHaveBeenCalledWith('Failed parsing viewports block', expect.any(Error));
        // The viewports config was lost, so the default viewport is shown.
        expect(screen.getByText('Default')).toBeInTheDocument();
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('renders three viewports with the paired grid template', async () => {
      renderModel(`---
viewports:
  - name: One
    camera: [0, 0, 30]
  - name: Two
    camera: [0, 30, 0]
  - name: Three
    camera: [30, 0, 0]
---
attachment:clip.stl`);

      await waitForModelReady();

      expect(screen.getByText('One')).toBeInTheDocument();
      expect(screen.getByText('Two')).toBeInTheDocument();
      expect(screen.getByText('Three')).toBeInTheDocument();

      const grid = document.querySelector('.grid.gap-px') as HTMLElement | null;
      expect(grid).not.toBeNull();
      expect(grid!.style.gridTemplateColumns).toBe('1fr 1fr');
    });
  });

  describe('UV projections', () => {
    it('applies planar-y UV projection to STL geometry', async () => {
      renderModel(`---
uvProjection: planar-y
---
attachment:clip.stl`);

      await waitForModelReady();

      const stlLoader = lastInstance(STLLoader) as { parse: Mock };
      const geometry = stlLoader.parse.mock.results[0].value as {
        setAttribute: Mock;
      };
      expect(geometry.setAttribute).toHaveBeenCalledWith('uv', expect.anything());
    });

    it('applies planar-z UV projection to STL geometry', async () => {
      renderModel(`---
uvProjection: planar-z
---
attachment:clip.stl`);

      await waitForModelReady();

      const stlLoader = lastInstance(STLLoader) as { parse: Mock };
      const geometry = stlLoader.parse.mock.results[0].value as {
        setAttribute: Mock;
      };
      expect(geometry.setAttribute).toHaveBeenCalledWith('uv', expect.anything());
    });

    it('skips UV generation when geometry has no position attribute', async () => {
      (STLLoader as unknown as Mock).mockImplementationOnce(() => ({
        parse: vi.fn(() => ({
          center: vi.fn(),
          computeVertexNormals: vi.fn(),
          computeBoundingSphere: vi.fn(),
          boundingSphere: { radius: 10 },
          getAttribute: vi.fn(() => undefined),
        })),
      }));

      renderModel(`---
uvProjection: planar-x
---
attachment:clip.stl`);

      await waitForModelReady();
      expect(screen.getByText('clip.stl')).toBeInTheDocument();
    });
  });

  describe('OBJ loading', () => {
    it('loads an OBJ attachment with texture override, UV projection and centered group', async () => {
      renderModel(`---
texture: attachment:tex.png
uvProjection: planar-x
---
attachment:model.obj`, noteWith(objAttachment, texAttachment), 'obj');

      await waitForModelReady();

      expect(screen.getByText('model.obj')).toBeInTheDocument();
      expect(screen.getByText('2.0 KB')).toBeInTheDocument();

      // The texture override reached the OBJ meshes (both the load-time
      // traverse and the viewport mount traverse assign textured materials).
      const stdMaterial = THREE.MeshStandardMaterial as unknown as Mock;
      expect(stdMaterial.mock.calls.some((call) => (call[0] as { map?: unknown })?.map)).toBe(true);

      // The parsed group was centered via Box3.getCenter.
      const objLoader = lastInstance(OBJLoader) as { parse: Mock };
      const group = objLoader.parse.mock.results[0].value as { position: { sub: Mock } };
      expect(group.position.sub).toHaveBeenCalled();
    });

    it('mounts OBJ groups in Surface Angle mode', async () => {
      renderModel(`---
mode: Surface Angle
---
attachment:model.obj`, noteWith(objAttachment), 'obj');

      await waitForModelReady();

      expect(screen.getByText('model.obj')).toBeInTheDocument();
      const normalMaterial = THREE.MeshNormalMaterial as unknown as Mock;
      expect(normalMaterial).toHaveBeenCalled();
    });

    it('mounts OBJ groups in Wireframe mode', async () => {
      renderModel(`---
mode: Wireframe
---
attachment:model.obj`, noteWith(objAttachment), 'obj');

      await waitForModelReady();

      expect(screen.getByText('model.obj')).toBeInTheDocument();
      const basicMaterial = THREE.MeshBasicMaterial as unknown as Mock;
      expect(basicMaterial).toHaveBeenCalled();
    });

    it('mounts STL meshes in Surface Angle mode', async () => {
      renderModel(`---
mode: Surface Angle
---
attachment:clip.stl`);

      await waitForModelReady();

      expect(screen.getByText('clip.stl')).toBeInTheDocument();
      const normalMaterial = THREE.MeshNormalMaterial as unknown as Mock;
      expect(normalMaterial).toHaveBeenCalled();
    });

    it('rebuilds OBJ child materials when the render mode changes', async () => {
      renderModel('attachment:model.obj', noteWith(objAttachment), 'obj');
      await waitForModelReady();

      const objLoader = lastInstance(OBJLoader) as { parse: Mock };
      const group = objLoader.parse.mock.results[0].value as { clone: Mock };
      const clone = group.clone.mock.results[0].value as { children: Array<Record<string, unknown>> };
      const meshChild = clone.children[0] as { material: { dispose: Mock } };

      // The current material is replaced (and disposed) on every mode change.
      const currentMaterial = meshChild.material;
      fireEvent.click(screen.getByText('Surface Angle'));
      expect(currentMaterial.dispose).toHaveBeenCalled();

      fireEvent.click(screen.getByText('Wireframe'));
      fireEvent.click(screen.getByText('Solid'));
      expect(THREE.MeshStandardMaterial as unknown as Mock).toHaveBeenCalled();
    });
  });

  describe('render mode switching', () => {
    it('rebuilds the STL material through every render mode', async () => {
      renderModel('attachment:clip.stl');
      await waitForModelReady();

      const stdMaterial = THREE.MeshStandardMaterial as unknown as Mock;
      const mountMaterial = stdMaterial.mock.results[0].value as { dispose: Mock };

      fireEvent.click(screen.getByText('Surface Angle'));
      expect(mountMaterial.dispose).toHaveBeenCalled();

      const normalMaterial = THREE.MeshNormalMaterial as unknown as Mock;
      const normalInstance = normalMaterial.mock.results[0].value as { dispose: Mock };
      fireEvent.click(screen.getByText('Wireframe'));
      expect(normalInstance.dispose).toHaveBeenCalled();

      const basicCalls = (THREE.MeshBasicMaterial as unknown as Mock).mock.calls.length;
      expect(basicCalls).toBeGreaterThan(0);
    });
  });

  describe('material arrays', () => {
    it('disposes material arrays on the STL mesh when the mode changes', async () => {
      hoisted.materialMode = 'array';
      renderModel('attachment:clip.stl');
      await waitForModelReady();

      const stdMaterial = THREE.MeshStandardMaterial as unknown as Mock;
      const materialArray = stdMaterial.mock.results[0].value as Array<{ dispose: Mock }>;
      expect(Array.isArray(materialArray)).toBe(true);
      expect(materialArray[0].dispose).toHaveBeenCalled();
    });

    it('disposes material arrays on OBJ children when the mode changes', async () => {
      hoisted.materialMode = 'array';
      renderModel('attachment:model.obj', noteWith(objAttachment), 'obj');
      await waitForModelReady();

      const stdMaterial = THREE.MeshStandardMaterial as unknown as Mock;
      const materialArray = stdMaterial.mock.results[0].value as Array<{ dispose: Mock }>;
      expect(Array.isArray(materialArray)).toBe(true);
      expect(materialArray[0].dispose).toHaveBeenCalled();
    });
  });

  describe('asset sources', () => {
    it('decodes an OBJ fetched from a remote URL', async () => {
      renderModel('url:https://cdn.example.com/files/robot.obj');
      await waitForModelReady();

      expect(screen.getByText('robot.obj')).toBeInTheDocument();
      expect(global.fetch).toHaveBeenCalledWith('https://cdn.example.com/files/robot.obj');
    });

    it('decodes an OBJ from an inline base64 data URL and derives its download name', async () => {
      renderModel('url:data:model/obj;base64,PD89PG9iaj4=');
      await waitForModelReady();

      expect(screen.getByText('model.obj')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Download'));
      expect(saveAs).toHaveBeenCalledWith('data:model/obj;base64,PD89PG9iaj4=', 'model.obj');
    });

    it('resolves data URLs without base64 payloads through fetch', async () => {
      renderModel('url:data:model/stl,raw-binary-bytes');
      await waitForModelReady();

      expect(screen.getByText('model.stl')).toBeInTheDocument();
      expect(global.fetch).toHaveBeenCalledWith('data:model/stl,raw-binary-bytes');
    });

    it('surfaces fetch HTTP failures as an error notice', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      });

      renderModel('url:https://cdn.example.com/missing.stl');
      await waitForModelReady();

      expect(screen.getByText('3D Model Rendering Error')).toBeInTheDocument();
      expect(screen.getByText(/Failed to fetch 3D model from/)).toBeInTheDocument();
    });

    it('shows the generic error message for non-Error rejections', async () => {
      global.fetch = vi.fn().mockRejectedValue('network down');

      renderModel('url:https://cdn.example.com/missing.stl');
      await waitForModelReady();

      expect(screen.getByText('Error loading 3D model.')).toBeInTheDocument();
    });

    it('downloads remote models with the derived filename', async () => {
      renderModel('url:https://cdn.example.com/files/robot.stl');
      await waitForModelReady();

      fireEvent.click(screen.getByText('Download'));
      expect(saveAs).toHaveBeenCalledWith('https://cdn.example.com/files/robot.stl', 'robot.stl');
    });
  });

  describe('viewport controls', () => {
    it('drives orbit, zoom, reset and auto-rotate controls', async () => {
      renderModel('attachment:clip.stl');
      await waitForModelReady();

      fireEvent.click(screen.getByTitle('Tilt Up'));
      fireEvent.click(screen.getByTitle('Orbit Left'));
      fireEvent.click(screen.getByTitle('Orbit Right'));
      fireEvent.click(screen.getByTitle('Tilt Down'));

      const controls = lastControls();
      expect(controls.rotateUp).toHaveBeenCalledWith(0.15);
      expect(controls.rotateUp).toHaveBeenCalledWith(-0.15);
      expect(controls.rotateLeft).toHaveBeenCalledWith(0.15);
      expect(controls.rotateLeft).toHaveBeenCalledWith(-0.15);
      expect(controls.update).toHaveBeenCalled();

      fireEvent.click(screen.getByTitle('Zoom In'));
      expect(controls.dollyIn).toHaveBeenCalledWith(1.15);
      fireEvent.click(screen.getByTitle('Zoom Out'));
      expect(controls.dollyOut).toHaveBeenCalledWith(1.15);

      fireEvent.click(screen.getByTitle('Reset Camera View'));
      expect(controls.target.set).toHaveBeenCalledWith(0, 0, 0);
      expect(controls.update).toHaveBeenCalled();

      fireEvent.click(screen.getByTitle('Spin Model'));
      expect(lastControls().autoRotate).toBe(true);
      expect(screen.getByTitle('Pause Rotation')).toBeInTheDocument();
      fireEvent.click(screen.getByTitle('Pause Rotation'));
      expect(lastControls().autoRotate).toBe(false);
    });

    it('pans the camera in all four directions', async () => {
      renderModel('attachment:clip.stl');
      await waitForModelReady();

      const controls = lastControls();
      fireEvent.click(screen.getByTitle('Pan Up'));
      fireEvent.click(screen.getByTitle('Pan Left'));
      fireEvent.click(screen.getByTitle('Pan Right'));
      fireEvent.click(screen.getByTitle('Pan Down'));

      expect(controls.target.add).toHaveBeenCalledTimes(4);
      expect(controls.update).toHaveBeenCalled();
    });

    it('resets and pans OBJ views using the frontmatter camera', async () => {
      renderModel(`---
camera: [0, 0, 30]
---
attachment:model.obj`, noteWith(objAttachment), 'obj');
      await waitForModelReady();

      const controls = lastControls();

      fireEvent.click(screen.getByTitle('Reset Camera View'));
      expect(controls.target.set).toHaveBeenCalledWith(0, 0, 0);

      fireEvent.click(screen.getByTitle('Pan Up'));
      expect(controls.target.add).toHaveBeenCalled();
    });

    it('shows the standalone reset control when panning is disabled', async () => {
      renderModel(`---
pan: false
---
attachment:clip.stl`);
      await waitForModelReady();

      expect(screen.queryByTitle('Pan Up')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTitle('Reset Camera View'));
      expect(lastControls().target.set).toHaveBeenCalledWith(0, 0, 0);
    });
  });

  describe('resize handling', () => {
    it('resizes the perspective renderer and camera from the observer', async () => {
      renderModel('attachment:clip.stl');
      await waitForModelReady();

      expect(hoisted.resizeObserverInstances).toHaveLength(1);
      const renderer = lastRenderer();
      (renderer.setSize as Mock).mockClear();

      fireResize(800, 480);

      expect(renderer.setSize).toHaveBeenCalledWith(800, 400);
      expect(lastInstance(THREE.PerspectiveCamera).updateProjectionMatrix).toHaveBeenCalled();
    });

    it('resizes the orthographic camera from the observer', async () => {
      renderModel(`---
viewports:
  - name: Top
    camera: [0, 30, 0]
    projection: orthographic
---
attachment:clip.stl`);
      await waitForModelReady();

      fireResize(640, 480);

      expect(lastInstance(THREE.OrthographicCamera).updateProjectionMatrix).toHaveBeenCalled();
      expect(lastRenderer().setSize).toHaveBeenCalledWith(640, 400);
    });
  });

  describe('lifecycle', () => {
    it('drives the animation loop and disposes renderer, controls and observers on unmount', async () => {
      const rafCallbacks: FrameRequestCallback[] = [];
      let nextFrameId = 500;
      const rafSpy = vi
        .spyOn(globalThis, 'requestAnimationFrame')
        .mockImplementation((callback: FrameRequestCallback) => {
          nextFrameId += 1;
          rafCallbacks.push(callback);
          return nextFrameId;
        });
      const cafSpy = vi.spyOn(globalThis, 'cancelAnimationFrame');

      try {
        const utils = renderModel('attachment:clip.stl');
        await waitForModelReady();

        const renderer = lastRenderer();
        const controls = lastControls();
        const rendersBefore = callCount(renderer.render);
        const updatesBefore = callCount(controls.update);

        // Pump captured animation frames with increasing timestamps. Each
        // invocation schedules exactly one follow-up frame, so drain the
        // captured queue repeatedly to advance several frames.
        act(() => {
          for (let frame = 1; frame <= 3; frame += 1) {
            rafCallbacks
              .splice(0, rafCallbacks.length)
              .forEach((callback) => callback(16 * frame));
          }
        });

        expect(callCount(renderer.render)).toBeGreaterThanOrEqual(rendersBefore + 2);
        expect(callCount(controls.update)).toBeGreaterThanOrEqual(updatesBefore + 2);

        const expectedFrameId = nextFrameId;
        utils.unmount();

        expect(cafSpy).toHaveBeenCalledWith(expectedFrameId);
        expect(renderer.dispose).toHaveBeenCalled();
        expect(controls.dispose).toHaveBeenCalled();
        expect(hoisted.resizeObserverInstances[0].disconnect).toHaveBeenCalled();
        expect(renderer.domElement.parentNode).toBeNull();
      } finally {
        rafSpy.mockRestore();
        cafSpy.mockRestore();
      }
    });

    it('reloads the viewport when switching between STL and OBJ attachments', async () => {
      const utils = renderModel('attachment:clip.stl', noteWith(objAttachment));
      await waitForModelReady();

      // Switching between an STL and an OBJ attachment re-runs the load effect
      // (loading flips back on first, so the viewport never renders with stale
      // data) and then re-mounts the viewport with the freshly parsed model.
      utils.rerender(
        React.createElement(Model3DBlock, {
          code: 'attachment:model.obj',
          language: 'obj',
          note: noteWith(objAttachment),
        })
      );

      await waitFor(() => {
        expect(screen.getByText('Wireframe')).toBeInTheDocument();
      });
      expect(screen.getByText('model.obj')).toBeInTheDocument();
    });
  });
});