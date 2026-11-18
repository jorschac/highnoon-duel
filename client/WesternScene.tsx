import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import type { PlayerView, ResultView } from '../shared/protocol';

interface Props {
  players: PlayerView[];
  selfId?: string;
  drawn: boolean;
  result: ResultView | null;
  reducedMotion: boolean;
  onReady?: () => void;
  lobby?: boolean;
}
interface Cowboy { root: THREE.Group; arm: THREE.Group; halo: THREE.Mesh }
const colors = { ink: 0x30271f, sand: 0xdec59c, wood: 0x89664a, green: 0x446855, red: 0xae4935, gold: 0xc89c51 };

export function WesternScene(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [webgl, setWebgl] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: THREE.WebGLRenderer | undefined;
    let frame = 0;
    let observer: ResizeObserver | undefined;
    let contextLost: (() => void) | undefined;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xead5ad);
    scene.fog = new THREE.Fog(0xead5ad, 19, 35);
    const materials = new Map<number, THREE.MeshStandardMaterial>();
    const material = (color: number) => {
      if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true }));
      return materials.get(color)!;
    };
    const box = (parent: THREE.Object3D, size: [number, number, number], position: [number, number, number], color: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material(color));
      mesh.position.set(...position); parent.add(mesh); return mesh;
    };
    const cylinder = (parent: THREE.Object3D, top: number, bottom: number, height: number, position: [number, number, number], color: number, segments = 8) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(top, bottom, height, segments), material(color));
      mesh.position.set(...position); parent.add(mesh); return mesh;
    };
    const camera = new THREE.OrthographicCamera(-6.5, 6.5, 3.65, -3.65, 0.1, 60);
    camera.position.set(0, 5.5, 12); camera.lookAt(0, 1.25, 0);
    scene.add(new THREE.AmbientLight(0xffecd0, 2.3));
    const light = new THREE.DirectionalLight(0xffddae, 3.1); light.position.set(-4, 8, 6); scene.add(light);
    box(scene, [50, 0.1, 40], [0, -0.08, -3], colors.sand);
    // Sun, mesa silhouettes, road markings, and a tiny frontier town.
    const sun = new THREE.Mesh(new THREE.CircleGeometry(1.8, 32), new THREE.MeshBasicMaterial({ color: 0xe0b05f }));
    sun.position.set(0.3, 3.25, -8); scene.add(sun);
    for (const [x, width, height] of [[-4.8, 2.4, 1.4], [-1.9, 1.2, 1], [3.8, 2.7, 1.8], [6.2, 1.7, 1.2]]) {
      box(scene, [width, height, 0.9], [x, height / 2, -6], 0xbb9772);
      box(scene, [width * 0.65, 0.45, 0.8], [x, height + 0.2, -6], 0xbb9772);
    }
    for (let i = 0; i < 16; i++) box(scene, [0.35 + (i % 4) * 0.17, 0.015, 0.04], [(i * 1.7) % 12 - 6, 0, (i * 2.3) % 7 - 3], 0xc5a77f);
    const building = (x: number, color: number) => {
      const town = new THREE.Group(); town.position.set(x, 0, -2.5); scene.add(town);
      box(town, [2, 2.4, 1.5], [0, 1.2, 0], color);
      box(town, [2.3, 0.2, 1.9], [0, 2.47, 0.2], colors.ink);
      box(town, [2.15, 0.7, 0.17], [0, 2.6, 0.8], colors.wood);
      for (let i = 0; i < 7; i++) box(town, [2.01, 0.025, 0.03], [0, 0.2 + i * 0.31, 0.78], 0x6d503a);
      box(town, [0.6, 1.4, 0.1], [0, 0.7, 0.79], colors.ink);
      for (const sign of [-1, 1]) {
        box(town, [0.47, 0.5, 0.12], [sign * 0.65, 1.65, 0.8], 0xe0bd86);
        box(town, [0.07, 1.7, 0.07], [sign * 0.96, 0.85, 1.4], colors.ink);
      }
      box(town, [2.2, 0.1, 0.85], [0, 1.8, 1.1], colors.wood);
      box(town, [2.2, 0.12, 1], [0, 0.05, 1.1], 0x997754);
    };
    building(-5.5, 0x927653); building(5.5, 0xa7825a);
    const cactus = (x: number, z: number, scale: number) => {
      const group = new THREE.Group(); group.position.set(x, 0, z); group.scale.setScalar(scale); scene.add(group);
      cylinder(group, 0.12, 0.16, 1.4, [0, 0.7, 0], colors.green, 6);
      for (const side of [-1, 1]) {
        const branch = cylinder(group, 0.08, 0.09, 0.4, [side * 0.22, 0.75, 0], colors.green, 6); branch.rotation.z = Math.PI / 2;
        cylinder(group, 0.08, 0.09, 0.42, [side * 0.42, 0.94, 0], colors.green, 6);
      }
    };
    cactus(-3.5, -3.8, 0.8); cactus(3.6, -3.5, 1); cactus(-5.1, 1.5, 0.55);
    const cowboy = (index: number): Cowboy => {
      const root = new THREE.Group(); root.position.set(index ? 2.65 : -2.65, 0, 0.7);
      if (index) root.rotation.y = Math.PI;
      scene.add(root);
      const halo = new THREE.Mesh(new THREE.RingGeometry(0.43, 0.53, 24), new THREE.MeshBasicMaterial({ color: colors.gold, side: THREE.DoubleSide, transparent: true, opacity: 0 }));
      halo.rotation.x = -Math.PI / 2; halo.position.y = 0.015; root.add(halo);
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(0.45, 20), new THREE.MeshBasicMaterial({ color: 0x6c573b, transparent: true, opacity: 0.18 }));
      shadow.rotation.x = -Math.PI / 2; shadow.position.set(0.12, 0.008, 0); shadow.scale.set(1.4, 0.7, 1); root.add(shadow);
      for (const side of [-1, 1]) {
        box(root, [0.19, 0.67, 0.24], [side * 0.16, 0.43, 0], 0x443c31);
        box(root, [0.24, 0.2, 0.43], [side * 0.16, 0.1, 0.09], colors.ink);
      }
      box(root, [0.57, 0.65, 0.36], [0, 1.14, 0], index ? colors.red : colors.green);
      box(root, [0.25, 0.58, 0.38], [0, 1.14, 0.01], 0xe3ceb0);
      box(root, [0.62, 0.1, 0.39], [0, 0.87, 0], colors.ink);
      box(root, [0.13, 0.12, 0.04], [0, 0.87, 0.23], colors.gold);
      cylinder(root, 0.11, 0.11, 0.16, [0, 1.52, 0], 0xb88c63);
      box(root, [0.35, 0.37, 0.35], [0, 1.76, 0], 0xc29a71);
      box(root, [0.08, 0.12, 0.13], [0.2, 1.72, 0], 0xc29a71);
      cylinder(root, 0.46, 0.46, 0.08, [0, 1.97, 0], colors.ink, 12);
      cylinder(root, 0.24, 0.28, 0.28, [-0.03, 2.12, 0], colors.ink, 8);
      cylinder(root, 0.27, 0.28, 0.06, [-0.03, 2.01, 0], 0x72533b, 8);
      box(root, [0.42, 0.13, 0.42], [0, 1.46, 0], index ? 0x63372c : 0x8f4934);
      box(root, [0.18, 0.52, 0.23], [-0.35, 1.18, 0], 0xcdb690);
      const arm = new THREE.Group(); arm.position.set(0.26, 1.42, 0.14); root.add(arm);
      box(arm, [0.53, 0.19, 0.22], [0.26, 0, 0], 0xcdb690);
      box(arm, [0.19, 0.16, 0.2], [0.57, 0, 0], 0xc29a71);
      box(arm, [0.36, 0.1, 0.12], [0.76, 0.07, 0], colors.ink);
      box(arm, [0.11, 0.23, 0.11], [0.65, -0.02, 0], 0x65452f);
      arm.rotation.z = -1.35;
      return { root, arm, halo };
    };
    const cowboys = [cowboy(0), cowboy(1)];
    const dispose = () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      if (contextLost && renderer) renderer.domElement.removeEventListener('webglcontextlost', contextLost);
      scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const list = Array.isArray(object.material) ? object.material : [object.material];
          for (const mat of list) mat.dispose();
        }
      });
      renderer?.dispose();
      renderer?.domElement.remove();
    };
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      element.appendChild(renderer.domElement);
      const resize = () => {
        if (!renderer) return;
        const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight);
        const aspect = width / height;
        const worldWidth = Math.max(11.5, aspect * 6.1);
        camera.left = -worldWidth / 2; camera.right = worldWidth / 2;
        camera.top = worldWidth / aspect / 2; camera.bottom = -worldWidth / aspect / 2;
        camera.updateProjectionMatrix(); renderer.setSize(width, height, false);
      };
      observer = new ResizeObserver(resize); observer.observe(element); resize();
      contextLost = () => { setWebgl(false); latest.current.onReady?.(); window.cancelAnimationFrame(frame); };
      renderer.domElement.addEventListener('webglcontextlost', contextLost);
      const draw = () => {
        const current = latest.current;
        cowboys.forEach((character, index) => {
          const id = current.players[index]?.id;
          const shotLoser = !!id && current.result?.reason === 'SHOT' && current.result.loserId === id;
          const isDrawn = !!id && ((current.selfId === id && current.drawn) || (current.result?.reason === 'SHOT' && current.result.shooterId === id));
          const rotation = shotLoser ? (index ? 1.45 : -1.45) : 0;
          const smoothing = current.reducedMotion ? 1 : 0.15;
          character.root.rotation.z += (rotation - character.root.rotation.z) * smoothing;
          character.arm.rotation.z += ((isDrawn ? 0 : -1.35) - character.arm.rotation.z) * smoothing;
          (character.halo.material as THREE.MeshBasicMaterial).opacity = id && current.result?.winnerId === id ? 0.85 : 0;
        });
        renderer?.render(scene, camera);
        frame = window.requestAnimationFrame(draw);
      };
      draw(); setWebgl(true); latest.current.onReady?.();
    } catch { setWebgl(false); latest.current.onReady?.(); dispose(); }
    return dispose;
  }, []);

  return <div className={`western-scene ${props.lobby ? 'scene-lobby' : ''}`} role="img" aria-label="荒漠小镇，两名戴帽牛仔面对面等待决斗。命中与胜负由服务器裁判决定。">
    <div className={`css-frontier ${webgl ? 'hidden-scene' : ''}`} aria-hidden="true">
      <div className="frontier-sun"/><div className="frontier-mesa mesa-one"/><div className="frontier-mesa mesa-two"/>
      <div className="frontier-building building-left"><span>SALOON</span></div><div className="frontier-building building-right"><span>GENERAL STORE</span></div>
      {[0, 1].map(index => {
        const id = props.players[index]?.id;
        const hit = !!id && props.result?.reason === 'SHOT' && props.result.loserId === id;
        const drawn = !!id && ((props.drawn && id === props.selfId) || (props.result?.reason === 'SHOT' && props.result.shooterId === id));
        return <div key={index} className={`css-cowboy cowboy-${index} ${hit ? 'is-hit' : ''} ${drawn ? 'is-drawn' : ''}`}><i className="cowboy-hat"/><i className="cowboy-head"/><i className="cowboy-body"/><i className="cowboy-arm"/><i className="cowboy-legs"/></div>;
      })}
      <span className="fallback-caption">轻量场景模式</span>
    </div>
    <div className={`webgl-host ${webgl ? '' : 'hidden-scene'}`} ref={host}/>
    <div className="scene-grain" aria-hidden="true"/>
  </div>;
}
