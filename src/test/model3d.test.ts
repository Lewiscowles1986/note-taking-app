import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import Model3DBlock from '../components/Model3DBlock';
import { saveAs } from 'file-saver';

// Mock file-saver
vi.mock('file-saver', () => ({
  saveAs: vi.fn(),
}));

// Mock ResizeObserver globally for headless jsdom tests
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));


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
      target: { set: vi.fn(), add: vi.fn() },
    })),
  };
});

// Mock STLLoader and OBJLoader
vi.mock('three/examples/jsm/loaders/STLLoader.js', () => {
  return {
    STLLoader: vi.fn().mockImplementation(() => ({
      parse: vi.fn().mockReturnValue({
        center: vi.fn(),
        computeVertexNormals: vi.fn(),
        computeBoundingSphere: vi.fn(),
        boundingSphere: { radius: 10 },
        getAttribute: vi.fn().mockReturnValue({ count: 10 }),
        setAttribute: vi.fn(),
      }),
    })),
  };
});

vi.mock('three/examples/jsm/loaders/OBJLoader.js', () => {
  return {
    OBJLoader: vi.fn().mockImplementation(() => ({
      parse: vi.fn().mockReturnValue({
        clone: vi.fn().mockReturnThis(),
        traverse: vi.fn(),
        position: { sub: vi.fn() },
      }),
    })),
  };
});

// Mock three.js
vi.mock('three', async (importOriginal) => {
  const actual: any = await importOriginal();
  
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
    position: { set: vi.fn(), add: vi.fn(), multiplyScalar: vi.fn() },
    lookAt: vi.fn(),
    updateProjectionMatrix: vi.fn(),
  }));

  const mockMesh = vi.fn().mockImplementation(() => ({
    rotation: { x: 0, y: 0, z: 0 },
    position: { add: vi.fn(), sub: vi.fn() },
  }));

  return {
    ...actual,
    WebGLRenderer: mockWebGLRenderer,
    Scene: mockScene,
    PerspectiveCamera: mockCamera,
    Mesh: mockMesh,
    PlaneGeometry: vi.fn().mockImplementation(() => ({})),
    MeshBasicMaterial: vi.fn().mockImplementation(() => ({})),
    MeshStandardMaterial: vi.fn().mockImplementation(() => ({})),
    MeshNormalMaterial: vi.fn().mockImplementation(() => ({})),
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
      add(v: any) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
      sub(v: any) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
      normalize() { return this; }
      subVectors(a: any, b: any) {
        this.x = a.x - b.x;
        this.y = a.y - b.y;
        this.z = a.z - b.z;
        return this;
      }
      addScaledVector(v: any, s: number) {
        this.x += v.x * s;
        this.y += v.y * s;
        this.z += v.z * s;
        return this;
      }
      crossVectors() { return this; }
    },
    Box3: class {
      setFromObject() { return this; }
      getCenter(v: any) { v.set(0, 0, 0); return v; }
      getBoundingSphere(s: any) { s.radius = 10; return s; }
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
  const mockNote: any = {
    id: 1,
    title: 'Test Note',
    attachments: [
      {
        id: 'clip-uuid',
        name: 'clip.stl',
        type: 'model/stl',
        size: 7684,
        data: 'data:model/stl;base64,Q09MT1I9AAAAAAAAAAAAAAAAAAAAAAA=',
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock global fetch to handle data URL decoding or remote mock fetches
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
  });

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
});
