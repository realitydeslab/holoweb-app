// Shared three.js AR hit-test scene (port of three.js webxr_ar_hittest) for the HoloWeb examples.
// window.__arStatus is read by scripts/e2e.mjs.
import * as THREE from 'three/webgpu';
import { ARButton } from 'three/addons/webxr/ARButton.js';

export function runARScene({ renderer, sessionInit }) {
  const status = (window.__arStatus = {
    backend: '',
    xrFrames: 0,
    hitFrames: 0,
    placed: 0,
    sessionFeatures: [],
    views: 0,
    errors: [],
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 20);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xbbbbff, 3));

  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  document.body.appendChild(renderer.domElement);

  const button = ARButton.createButton(renderer, sessionInit);
  button.id = 'ARButton';
  document.body.appendChild(button);

  const reticle = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x33ddff }),
  );
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  const cylinder = new THREE.CylinderGeometry(0.1, 0.1, 0.2, 32).translate(0, 0.1, 0);
  const controller = renderer.xr.getController(0);
  controller.addEventListener('select', () => {
    if (!reticle.visible) return;
    const mesh = new THREE.Mesh(cylinder, new THREE.MeshPhongMaterial({ color: 0xffffff * Math.random() }));
    reticle.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    scene.add(mesh);
    status.placed++;
  });
  scene.add(controller);

  let hitTestSource = null;
  let hitTestRequested = false;

  renderer.xr.addEventListener('sessionstart', () => {
    const session = renderer.xr.getSession();
    status.sessionFeatures = [...session.enabledFeatures];
    status.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl';
  });

  function render(timestamp, frame) {
    if (frame) {
      status.xrFrames++;
      const referenceSpace = renderer.xr.getReferenceSpace();
      const session = renderer.xr.getSession();
      const pose = frame.getViewerPose(referenceSpace);
      status.views = pose ? pose.views.length : 0;
      if (!hitTestRequested) {
        session.requestReferenceSpace('viewer').then((viewer) =>
          session.requestHitTestSource({ space: viewer }).then((source) => (hitTestSource = source)),
        );
        session.addEventListener('end', () => {
          hitTestRequested = false;
          hitTestSource = null;
        });
        hitTestRequested = true;
      }
      if (hitTestSource) {
        const hits = frame.getHitTestResults(hitTestSource);
        reticle.visible = hits.length > 0;
        if (hits.length) {
          status.hitFrames++;
          reticle.matrix.fromArray(hits[0].getPose(referenceSpace).transform.matrix);
        }
      }
    }
    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(render);

  // Unattended device testing: ?autostart enters AR without a tap, ?mode=stereo asks native
  // for HoloKit mode, ?stats logs frame statistics every 2 s to the console.
  const params = new URLSearchParams(location.search);
  if (params.has('autostart')) {
    const start = async () => {
      if (params.get('mode') === 'stereo') await globalThis.__holoweb?.setMode?.('stereo');
      const session = await navigator.xr.requestSession('immersive-ar', sessionInit);
      renderer.xr.setReferenceSpaceType('local');
      await renderer.xr.setSession(session);
    };
    start().catch((e) => console.error('autostart failed: ' + e.message));
  }
  if (params.has('stats') || params.has('autostart')) {
    let lastFrames = 0;
    setInterval(() => {
      const latest = globalThis.__holoweb?.bridge?.latest;
      console.log('[ar-scene] ' + JSON.stringify({
        xrFps: (status.xrFrames - lastFrames) / 2, views: status.views, backend: status.backend,
        hitFrames: status.hitFrames, features: status.sessionFeatures,
        latencyMs: latest?.latencyMs, mode: latest?.mode, tracking: latest?.tracking,
        canvas: [renderer.domElement.width, renderer.domElement.height], errors: status.errors.slice(-3),
      }));
      lastFrames = status.xrFrames;
    }, 2000);
  }
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  addEventListener('error', (e) => status.errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => status.errors.push(String(e.reason)));
}
