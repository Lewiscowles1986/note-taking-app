import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { saveAs } from 'file-saver';
import {
  Download,
  AlertCircle,
  Play,
  Pause,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Box as BoxIcon
} from 'lucide-react';
import type { Note, NoteAttachment } from '@/lib/db';

interface Model3DBlockProps {
  code: string;
  language: string;
  note: Note;
}

interface ViewportConfig {
  name: string;
  camera?: [number, number, number];
  pan?: boolean;
  zoom?: boolean;
  drag?: boolean;
  mode?: 'Solid' | 'Surface Angle' | 'Wireframe';
}

function parseFrontmatterAndContent(code: string) {
  const match = code.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (match) {
    const yamlStr = match[1];
    const content = match[2];
    const config: any = {};

    const lines = yamlStr.split('\n');
    for (const line of lines) {
      const colIdx = line.indexOf(':');
      if (colIdx !== -1) {
        const key = line.slice(0, colIdx).trim();
        const value = line.slice(colIdx + 1).trim();

        if (value === 'true') {
          config[key] = true;
        } else if (value === 'false') {
          config[key] = false;
        } else if (value.startsWith('[') && value.endsWith(']')) {
          try {
            config[key] = JSON.parse(value);
          } catch (e) {
            config[key] = value;
          }
        } else if (value.startsWith('-') || !isNaN(Number(value))) {
          // Simple YAML array parser for viewports lists
          config[key] = value;
        } else {
          config[key] = value;
        }
      }
    }

    // Try to parse complex arrays (like viewports list) if available
    try {
      if (yamlStr.includes('viewports:')) {
        const viewports: ViewportConfig[] = [];
        let currentViewport: any = null;
        let inViewports = false;

        const lines = yamlStr.split('\n');
        for (let line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('viewports:')) {
            inViewports = true;
            continue;
          }
          if (inViewports) {
            // Exit condition: root-level key (no indentation, starts with letter)
            if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('-')) {
              inViewports = false;
              continue;
            }

            if (trimmed.startsWith('-')) {
              if (currentViewport) {
                viewports.push(currentViewport);
              }
              currentViewport = {};
              const keyValPart = trimmed.slice(1).trim();
              if (keyValPart) {
                const col = keyValPart.indexOf(':');
                if (col !== -1) {
                  const k = keyValPart.slice(0, col).trim();
                  const v = keyValPart.slice(col + 1).trim();
                  currentViewport[k] = v === 'true' ? true : v === 'false' ? false : v.startsWith('[') ? JSON.parse(v) : !isNaN(Number(v)) ? Number(v) : v;
                }
              }
            } else if (currentViewport && trimmed.includes(':')) {
              const col = trimmed.indexOf(':');
              const k = trimmed.slice(0, col).trim();
              const v = trimmed.slice(col + 1).trim();
              currentViewport[k] = v === 'true' ? true : v === 'false' ? false : v.startsWith('[') ? JSON.parse(v) : !isNaN(Number(v)) ? Number(v) : v;
            }
          }
        }
        if (currentViewport) {
          viewports.push(currentViewport);
        }
        if (viewports.length > 0) {
          config.viewports = viewports;
        }
      }
    } catch (e) {
      console.error('Failed parsing viewports block', e);
    }

    return { config, content: content.trim() };
  }
  return { config: {}, content: code.trim() };
}

function applyPlanarUVs(geometry: THREE.BufferGeometry, projection: string = 'planar-y') {
  const positionAttribute = geometry.getAttribute('position');
  if (!positionAttribute) return;

  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const min = bbox.min;
  const max = bbox.max;
  const size = new THREE.Vector3().subVectors(max, min);

  const uvs = new Float32Array(positionAttribute.count * 2);
  for (let i = 0; i < positionAttribute.count; i++) {
    const x = positionAttribute.getX(i);
    const y = positionAttribute.getY(i);
    const z = positionAttribute.getZ(i);

    let u = 0, v = 0;
    if (projection === 'planar-x') {
      u = (y - min.y) / (size.y || 1);
      v = (z - min.z) / (size.z || 1);
    } else if (projection === 'planar-z') {
      u = (x - min.x) / (size.x || 1);
      v = (y - min.y) / (size.y || 1);
    } else { // planar-y
      u = (x - min.x) / (size.x || 1);
      v = (z - min.z) / (size.z || 1);
    }
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.attributes.uv.needsUpdate = true;
}

// Convert Base64 data URL to ArrayBuffer for binary loader parsers
async function dataUrlToArrayBuffer(dataUrl: string): Promise<ArrayBuffer> {
  const base64Index = dataUrl.indexOf(';base64,');
  if (base64Index === -1) {
    const res = await fetch(dataUrl);
    return await res.arrayBuffer();
  }
  const base64Str = dataUrl.slice(base64Index + ';base64,'.length);
  const binaryStr = atob(base64Str);
  const len = binaryStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes.buffer;
}

export default function Model3DBlock({ code, language, note }: Model3DBlockProps) {
  const { config, content } = useMemo(() => parseFrontmatterAndContent(code), [code]);

  // Identify file target (attachment or URL pointer)
  const fileTarget = useMemo(() => {
    let pointer = content;
    if (pointer.startsWith('url:')) {
      pointer = pointer.slice('url:'.length).trim();
    }
    return pointer;
  }, [content]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<NoteAttachment | null>(null);
  const [activeViewportIndex, setActiveViewportIndex] = useState<number>(0);

  // Loaded 3D objects
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [objGroup, setObjGroup] = useState<THREE.Group | null>(null);
  const [modelType, setModelType] = useState<'stl' | 'obj'>('stl');
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  // Search for the attachment in the note
  useEffect(() => {
    let searchName = fileTarget;
    if (searchName.startsWith('attachment:')) {
      searchName = searchName.slice('attachment:'.length);
    }

    const att = note.attachments.find(
      (a) =>
        a.id.toLowerCase() === searchName.toLowerCase() ||
        a.name.toLowerCase() === searchName.toLowerCase()
    );

    if (att) {
      setAttachment(att);
      const isObj = att.name.toLowerCase().endsWith('.obj');
      setModelType(isObj ? 'obj' : 'stl');
    } else {
      // Remote URL / direct data URL loading
      const isObj = fileTarget.includes('model/obj') || fileTarget.toLowerCase().endsWith('.obj') || language.toLowerCase() === 'obj';
      setModelType(isObj ? 'obj' : 'stl');
    }
  }, [fileTarget, note.attachments, language]);

  // Fetch asset data and parse it
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    const loadModel = async () => {
      try {
        let arrayBuffer: ArrayBuffer;
        let dataString = '';

        if (attachment) {
          arrayBuffer = await dataUrlToArrayBuffer(attachment.data);
          if (modelType === 'obj') {
            const decoder = new TextDecoder('utf-8');
            dataString = decoder.decode(arrayBuffer);
          }
        } else if (fileTarget.startsWith('data:')) {
          // Direct base64 data URL
          arrayBuffer = await dataUrlToArrayBuffer(fileTarget);
          if (modelType === 'obj') {
            const decoder = new TextDecoder('utf-8');
            dataString = decoder.decode(arrayBuffer);
          }
        } else {
          // Fetch from URL
          const res = await fetch(fileTarget);
          if (!res.ok) throw new Error(`Failed to fetch 3D model from "${fileTarget}"`);
          arrayBuffer = await res.arrayBuffer();
          if (modelType === 'obj') {
            const decoder = new TextDecoder('utf-8');
            dataString = decoder.decode(arrayBuffer);
          }
        }

        if (!active) return;

        // Parse Texture if set in frontmatter config
        let loadedTexture: THREE.Texture | null = null;
        if (config.texture) {
          let texUrl = config.texture;
          if (texUrl.startsWith('attachment:')) {
            const texName = texUrl.slice('attachment:'.length);
            const texAtt = note.attachments.find(
              (a) => a.id.toLowerCase() === texName.toLowerCase() || a.name.toLowerCase() === texName.toLowerCase()
            );
            if (texAtt) {
              texUrl = texAtt.data;
            }
          }
          const textureLoader = new THREE.TextureLoader();
          loadedTexture = await new Promise<THREE.Texture>((resolve, reject) => {
            textureLoader.load(texUrl, resolve, undefined, reject);
          });
          setTexture(loadedTexture);
        }

        // Parse Geometry/Group
        if (modelType === 'stl') {
          const stlLoader = new STLLoader();
          const geom = stlLoader.parse(arrayBuffer);
          
          if (config.uvProjection) {
            applyPlanarUVs(geom, config.uvProjection);
          }
          geom.center();
          geom.computeVertexNormals();

          if (active) {
            setGeometry(geom);
            setLoading(false);
          }
        } else {
          const objLoader = new OBJLoader();
          const group = objLoader.parse(dataString);

          // Apply texture override to children if loaded
          if (loadedTexture) {
            group.traverse((child) => {
              if (child instanceof THREE.Mesh) {
                if (config.uvProjection) {
                  applyPlanarUVs(child.geometry, config.uvProjection);
                }
                child.material = new THREE.MeshStandardMaterial({
                  map: loadedTexture,
                  roughness: 0.5,
                  metalness: 0.1
                });
              }
            });
          }

          // Center the group geometry
          const box = new THREE.Box3().setFromObject(group);
          const center = new THREE.Vector3();
          box.getCenter(center);
          group.position.sub(center);

          if (active) {
            setObjGroup(group);
            setLoading(false);
          }
        }
      } catch (err) {
        console.error('Error loading or parsing 3D model:', err);
        if (active) {
          setError(err instanceof Error ? err.message : 'Error loading 3D model.');
          setLoading(false);
        }
      }
    };

    loadModel();

    return () => {
      active = false;
    };
  }, [attachment, fileTarget, modelType, config.texture, config.uvProjection, note.attachments]);

  // Handle download triggering
  const handleDownload = () => {
    if (attachment) {
      saveAs(attachment.data, attachment.name);
    } else {
      const filename = fileTarget.startsWith('data:') ? `model.${modelType}` : fileTarget.split('/').pop() || `model.${modelType}`;
      saveAs(fileTarget, filename);
    }
  };

  // Determine viewport configurations from frontmatter
  const viewportsList = useMemo<ViewportConfig[]>(() => {
    if (config.viewports && Array.isArray(config.viewports)) {
      return config.viewports;
    }
    // Default to a single viewport using global settings
    return [{
      name: 'Default',
      camera: config.camera,
      pan: config.pan !== false,
      zoom: config.zoom !== false,
      drag: (config.drag !== false) && (config.grab !== false),
      mode: config.mode || 'Solid'
    }];
  }, [config]);

  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive p-4 rounded-md border border-destructive/20 my-3 flex items-start gap-3">
        <AlertCircle className="shrink-0 mt-0.5" size={16} />
        <div>
          <div className="font-semibold text-sm">3D Model Rendering Error</div>
          <div className="text-xs font-mono mt-1 whitespace-pre-wrap">{error}</div>
        </div>
      </div>
    );
  }

  // Header sizes/details formatting
  const modelName = attachment 
    ? attachment.name 
    : fileTarget.startsWith('data:') 
      ? `model.${modelType}`
      : fileTarget.split('/').pop() || `model.${modelType}`;
  const fileSizeStr = attachment ? `${(attachment.size / 1024).toFixed(1)} KB` : '';

  return (
    <div className="relative my-3 overflow-hidden rounded-md border border-border bg-card select-none">
      {/* Upper Control Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#24292e]">
        <div className="flex items-center gap-2">
          <BoxIcon size={14} className="text-white/50" />
          <span className="text-xs font-mono text-white font-medium">{modelName}</span>
          {fileSizeStr && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/60 font-mono">
              {fileSizeStr}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleDownload}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded transition-colors text-white/70 hover:text-white hover:bg-white/10"
            title="Download 3D Model file"
          >
            <Download size={12} />
            Download
          </button>
        </div>
      </div>

      {loading ? (
        <div className="w-full h-[400px] flex flex-col items-center justify-center bg-slate-50 gap-3 border-t border-border">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-xs text-muted-foreground font-medium">Loading 3D asset data...</span>
        </div>
      ) : (
        <div
          className={`grid gap-px bg-border border-t border-border`}
          style={{
            gridTemplateColumns:
              viewportsList.length === 1
                ? '1fr'
                : viewportsList.length === 2
                ? '1fr 1fr'
                : '1fr 1fr',
          }}
        >
          {viewportsList.map((vpConfig, index) => {
            const isActive = activeViewportIndex === index;
            return (
              <div
                key={index}
                onClick={() => setActiveViewportIndex(index)}
                className={`relative flex flex-col transition-all duration-200 cursor-pointer ${
                  viewportsList.length > 1
                    ? isActive
                      ? 'ring-2 ring-primary ring-inset z-10'
                      : 'opacity-85 hover:opacity-100'
                    : ''
                }`}
              >
                <Model3DViewport
                  geometry={geometry}
                  objGroup={objGroup}
                  modelType={modelType}
                  texture={texture}
                  config={vpConfig}
                  system={config.system}
                  showControls={isActive || viewportsList.length === 1}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface Model3DViewportProps {
  geometry: THREE.BufferGeometry | null;
  objGroup: THREE.Group | null;
  modelType: 'stl' | 'obj';
  texture: THREE.Texture | null;
  config: ViewportConfig;
  system?: string;
  showControls: boolean;
}

function Model3DViewport({
  geometry,
  objGroup,
  modelType,
  texture,
  config,
  system,
  showControls
}: Model3DViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderMode, setRenderMode] = useState<'Solid' | 'Surface Angle' | 'Wireframe'>(
    config.mode || 'Solid'
  );
  const [isSpinning, setIsSpinning] = useState(false);

  // References to allow programmatic trigger clicks
  const controlsRef = useRef<OrbitControls | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const modelMeshRef = useRef<THREE.Object3D | null>(null);

  // Check controls availability based on config parameters
  const canRotate = config.drag !== false;
  const canPan = config.pan !== false;
  const canZoom = config.zoom !== false;
  const showReset = canRotate || canPan || canZoom;

  useEffect(() => {
    if (!containerRef.current) return;

    const width = containerRef.current.clientWidth;
    const height = 400; // Standard fixed canvas height

    // 1. Setup Scene, Camera, Renderer
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    containerRef.current.appendChild(renderer.domElement);

    // 2. Setup Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
    scene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.65);
    dirLight1.position.set(1, 1.2, 1).normalize();
    scene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
    dirLight2.position.set(-1, -1, -1).normalize();
    scene.add(dirLight2);

    // 3. Create Grid
    const gridPlane = new THREE.PlaneGeometry(60, 60, 20, 20);
    const gridMat = new THREE.MeshBasicMaterial({
      color: 0xdde2eb,
      wireframe: true,
      transparent: true,
      opacity: 0.8
    });
    const gridMesh = new THREE.Mesh(gridPlane, gridMat);
    gridMesh.rotation.x = -Math.PI / 2;
    gridMesh.position.y = -0.01; // Slightly offset down to avoid Z-fighting
    scene.add(gridMesh);

    // 4. Mount Model
    let model: THREE.Object3D;
    let boundingSphere = new THREE.Sphere();

    if (modelType === 'stl' && geometry) {
      // Determine material based on mode
      let mat: THREE.Material;
      if (renderMode === 'Solid') {
        mat = new THREE.MeshStandardMaterial({
          color: 0x3b82f6, // Sleek blue
          roughness: 0.4,
          metalness: 0.2,
          map: texture || null
        });
      } else if (renderMode === 'Surface Angle') {
        mat = new THREE.MeshNormalMaterial();
      } else {
        mat = new THREE.MeshBasicMaterial({
          color: 0x1e3a8a, // Darker blue outline
          wireframe: true
        });
      }

      const mesh = new THREE.Mesh(geometry, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      model = mesh;

      geometry.computeBoundingSphere();
      boundingSphere = geometry.boundingSphere!;
    } else if (modelType === 'obj' && objGroup) {
      const groupClone = objGroup.clone();
      
      // Override material depending on mode
      groupClone.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;

          if (renderMode === 'Solid') {
            child.material = new THREE.MeshStandardMaterial({
              color: 0x3b82f6,
              roughness: 0.4,
              metalness: 0.2,
              map: texture || null
            });
          } else if (renderMode === 'Surface Angle') {
            child.material = new THREE.MeshNormalMaterial();
          } else {
            child.material = new THREE.MeshBasicMaterial({
              color: 0x1e3a8a,
              wireframe: true
            });
          }
        }
      });
      model = groupClone;

      const box = new THREE.Box3().setFromObject(model);
      box.getBoundingSphere(boundingSphere);
    } else {
      // Fallback
      model = new THREE.Object3D();
    }

    // Apply CAD Z-up orientation if specified (which is typical for STL)
    if (system !== 'y-up') {
      model.rotation.x = -Math.PI / 2;
    }

    scene.add(model);
    modelMeshRef.current = model;

    // 5. Configure Camera position
    const radius = boundingSphere.radius || 15;
    if (config.camera && Array.isArray(config.camera) && config.camera.length === 3) {
      camera.position.set(config.camera[0], config.camera[1], config.camera[2]);
    } else {
      camera.position.set(radius * 1.6, radius * 1.2, radius * 1.6);
    }
    camera.lookAt(0, 0, 0);

    // 6. Setup Orbit Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0);

    // Disable controls if customized in frontmatter
    controls.enablePan = config.pan !== false;
    controls.enableZoom = config.zoom !== false;
    controls.enableRotate = config.drag !== false;

    // Auto rotate state
    controls.autoRotate = isSpinning;
    controls.autoRotateSpeed = 2.0;

    controlsRef.current = controls;

    // 7. Render Loop
    let animationId: number;
    const animate = () => {
      animationId = requestAnimationFrame(animate);
      
      if (controls.autoRotate !== isSpinning) {
        controls.autoRotate = isSpinning;
      }

      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    // 8. Handle container resize
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver((entries) => {
        for (let entry of entries) {
          const { width, height } = entry.contentRect;
          camera.aspect = width / 400;
          camera.updateProjectionMatrix();
          renderer.setSize(width, 400);
        }
      });
      resizeObserver.observe(containerRef.current);
    }

    // Clean up
    return () => {
      cancelAnimationFrame(animationId);
      if (resizeObserver) {
        resizeObserver.disconnect();
      }
      controls.dispose();
      renderer.dispose();
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
    };
  }, [geometry, objGroup, modelType, texture, renderMode, isSpinning, config, system]);

  // Programmatic movement actions
  const triggerOrbit = (dir: 'left' | 'right' | 'up' | 'down') => {
    const controls = controlsRef.current;
    if (!controls) return;
    const angle = 0.15;
    if (dir === 'left') controls.rotateLeft(angle);
    else if (dir === 'right') controls.rotateLeft(-angle);
    else if (dir === 'up') controls.rotateUp(angle);
    else if (dir === 'down') controls.rotateUp(-angle);
    controls.update();
  };

  const triggerZoom = (zoomIn: boolean) => {
    const controls = controlsRef.current;
    if (!controls) return;
    if (zoomIn) {
      controls.dollyIn(1.15);
    } else {
      controls.dollyOut(1.15);
    }
    controls.update();
  };

  const triggerReset = () => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;

    controls.target.set(0, 0, 0);

    let radius = 15;
    if (geometry) {
      geometry.computeBoundingSphere();
      radius = geometry.boundingSphere?.radius || 15;
    } else if (objGroup) {
      const box = new THREE.Box3().setFromObject(objGroup);
      const sphere = new THREE.Sphere();
      box.getBoundingSphere(sphere);
      radius = sphere.radius || 15;
    }

    if (config.camera && Array.isArray(config.camera) && config.camera.length === 3) {
      camera.position.set(config.camera[0], config.camera[1], config.camera[2]);
    } else {
      camera.position.set(radius * 1.6, radius * 1.2, radius * 1.6);
    }
    controls.update();
  };

  const triggerPan = (dir: 'left' | 'right' | 'up' | 'down') => {
    const controls = controlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;

    let radius = 10;
    if (geometry) {
      geometry.computeBoundingSphere();
      radius = geometry.boundingSphere?.radius || 10;
    } else if (objGroup) {
      const box = new THREE.Box3().setFromObject(objGroup);
      const sphere = new THREE.Sphere();
      box.getBoundingSphere(sphere);
      radius = sphere.radius || 10;
    }

    const panSpeed = radius * 0.12;
    const offset = new THREE.Vector3();

    const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();

    if (dir === 'left') {
      offset.addScaledVector(right, panSpeed);
    } else if (dir === 'right') {
      offset.addScaledVector(right, -panSpeed);
    } else if (dir === 'up') {
      offset.addScaledVector(up, -panSpeed);
    } else if (dir === 'down') {
      offset.addScaledVector(up, panSpeed);
    }

    camera.position.add(offset);
    controls.target.add(offset);
    controls.update();
  };

  return (
    <div className="relative bg-white flex flex-col min-w-[280px]">
      {/* Sub Header for Name & Modes */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 bg-slate-50">
        <span className="text-xs font-semibold text-slate-500 font-sans">{config.name}</span>
        <div className="flex items-center rounded border border-slate-200 bg-white p-0.5 shadow-sm">
          {(['Solid', 'Surface Angle', 'Wireframe'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setRenderMode(mode)}
              className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors ${
                renderMode === mode
                  ? 'bg-slate-900 text-white font-semibold'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
              }`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Render Canvas Container */}
      <div ref={containerRef} className="relative w-full h-[400px] bg-white cursor-grab active:cursor-grabbing overflow-hidden" />

      {/* Navigation Overlay Buttons */}
      {showControls && (
        <>
          {/* Rotation / Auto-play (Bottom-Left) */}
          {canRotate && (
            <div className="absolute bottom-3 left-3 flex flex-col gap-1 z-10">
              <div className="grid grid-cols-3 grid-rows-3 gap-1 w-24 h-24 p-1 bg-slate-900/80 rounded-xl backdrop-blur-sm border border-white/10 shadow-lg select-none">
                <div />
                <button
                  onClick={() => triggerOrbit('up')}
                  className="flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Tilt Up"
                >
                  <ArrowUp size={16} />
                </button>
                <div />

                <button
                  onClick={() => triggerOrbit('left')}
                  className="flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Orbit Left"
                >
                  <ArrowLeft size={16} />
                </button>
                <button
                  onClick={() => setIsSpinning(!isSpinning)}
                  className={`flex items-center justify-center transition-colors rounded ${
                    isSpinning ? 'text-primary bg-primary/20' : 'text-white hover:text-primary hover:bg-white/10'
                  }`}
                  title={isSpinning ? 'Pause Rotation' : 'Spin Model'}
                >
                  {isSpinning ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button
                  onClick={() => triggerOrbit('right')}
                  className="flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Orbit Right"
                >
                  <ArrowRight size={16} />
                </button>

                <div />
                <button
                  onClick={() => triggerOrbit('down')}
                  className="flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Tilt Down"
                >
                  <ArrowDown size={16} />
                </button>
                <div />
              </div>
            </div>
          )}

          {/* Panning / Zooming / Reset (Bottom-Right) */}
          <div className="absolute bottom-3 right-3 flex gap-2 items-end z-10">
            {/* Pan Directional Controls */}
            {canPan && (
              <div className="grid grid-cols-3 grid-rows-3 gap-1 w-24 h-24 p-1 bg-slate-900/80 rounded-xl backdrop-blur-sm border border-white/10 shadow-lg select-none">
                <div />
                <button
                  onClick={() => triggerPan('up')}
                  className="flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Pan Up"
                >
                  <ArrowUp size={16} />
                </button>
                <div />

                <button
                  onClick={() => triggerPan('left')}
                  className="flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Pan Left"
                >
                  <ArrowLeft size={16} />
                </button>
                <button
                  onClick={triggerReset}
                  className="flex items-center justify-center text-white hover:text-primary hover:bg-white/10 transition-colors rounded"
                  title="Reset Camera View"
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  onClick={() => triggerPan('right')}
                  className="flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Pan Right"
                >
                  <ArrowRight size={16} />
                </button>

                <div />
                <button
                  onClick={() => triggerPan('down')}
                  className="flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Pan Down"
                >
                  <ArrowDown size={16} />
                </button>
                <div />
              </div>
            )}

            {/* Standalone Reset Button if Panning is disabled but Reset is still useful */}
            {!canPan && showReset && (
              <button
                onClick={triggerReset}
                className="w-8 h-8 flex items-center justify-center bg-slate-900/80 rounded-xl backdrop-blur-sm border border-white/10 shadow-lg text-white hover:text-primary hover:bg-white/10 transition-colors select-none"
                title="Reset Camera View"
              >
                <RotateCcw size={14} />
              </button>
            )}

            {/* Zoom Controls */}
            {canZoom && (
              <div className="flex flex-col gap-1 p-1 bg-slate-900/80 rounded-xl backdrop-blur-sm border border-white/10 shadow-lg select-none">
                <button
                  onClick={() => triggerZoom(true)}
                  className="w-8 h-8 flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Zoom In"
                >
                  <ZoomIn size={16} />
                </button>
                <button
                  onClick={() => triggerZoom(false)}
                  className="w-8 h-8 flex items-center justify-center text-white hover:text-primary transition-colors hover:bg-white/10 rounded"
                  title="Zoom Out"
                >
                  <ZoomOut size={16} />
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
