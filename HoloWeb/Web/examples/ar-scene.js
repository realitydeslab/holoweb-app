// Shared three.js AR hit-test scene (port of three.js webxr_ar_hittest) for the HoloWeb examples.
// Taps place objects on native anchors (hit.createAnchor) when 'anchors' is granted, and the
// light estimate is read every frame. window.__arStatus is read by scripts/e2e.mjs.
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
    anchors: 0,
    light: null,
    errors: [],
  });
  // exercise anchors + light estimation when the runtime offers them
  sessionInit.optionalFeatures = [...new Set([...(sessionInit.optionalFeatures ?? []), 'anchors', 'light-estimation'])];

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
  const newMesh = () => {
    const mesh = new THREE.Mesh(cylinder, new THREE.MeshPhongMaterial({ color: 0xffffff * Math.random() }));
    scene.add(mesh);
    status.placed++;
    return mesh;
  };
  // Anchors must be created from a hit result of the current frame, so select only flags it.
  let placeRequested = false;
  const anchored = []; // { anchor, mesh }
  const controller = renderer.xr.getController(0);
  controller.addEventListener('select', () => {
    if (reticle.visible) placeRequested = true;
  });
  scene.add(controller);

  function place(frame, hit) {
    placeRequested = false;
    const session = frame.session;
    if (session.enabledFeatures.includes('anchors') && hit.createAnchor) {
      hit.createAnchor().then(
        (anchor) => anchored.push({ anchor, mesh: newMesh() }),
        (e) => status.errors.push('createAnchor: ' + e.message),
      );
    } else {
      const mesh = newMesh();
      reticle.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
    }
  }

  function updateAnchors(frame, referenceSpace) {
    const tracked = frame.trackedAnchors;
    status.anchors = tracked ? tracked.size : 0;
    for (const { anchor, mesh } of anchored) {
      const live = tracked && tracked.has(anchor);
      mesh.visible = Boolean(live);
      if (!live) continue;
      const pose = frame.getPose(anchor.anchorSpace, referenceSpace);
      if (pose) {
        mesh.matrix.fromArray(pose.transform.matrix);
        mesh.matrix.decompose(mesh.position, mesh.quaternion, mesh.scale);
      }
    }
  }

  let lightProbe = null;
  function updateLight(frame) {
    const est = lightProbe && frame.getLightEstimate(lightProbe);
    if (!est) return;
    const p = est.primaryLightIntensity;
    const r2 = (v) => Math.round(v * 100) / 100;
    status.light = { sh0: r2(est.sphericalHarmonicsCoefficients[0]), primary: [r2(p.x), r2(p.y), r2(p.z)] };
  }

  let hitTestSource = null;
  let hitTestRequested = false;

  renderer.xr.addEventListener('sessionstart', () => {
    const session = renderer.xr.getSession();
    status.sessionFeatures = [...session.enabledFeatures];
    status.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl';
    lightProbe = null;
    if (session.enabledFeatures.includes('light-estimation') && session.requestLightProbe) {
      session.requestLightProbe().then((probe) => (lightProbe = probe), (e) => status.errors.push('lightProbe: ' + e.message));
    }
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
          if (placeRequested) place(frame, hits[0]);
        }
      }
      updateAnchors(frame, referenceSpace);
      updateLight(frame);
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
        xrFps: (status.xrFrames - lastFrames) / 2, views: status.views,
        // views that actually draw: an inert, zero-viewport view may remain after stereo -> mono
        activeViews: renderer.xr.isPresenting ? renderer.xr.getCamera().cameras.filter((c) => c.viewport && c.viewport.z > 0 && c.viewport.w > 0).length : 0, backend: status.backend,
        hitFrames: status.hitFrames, features: status.sessionFeatures,
        latencyMs: latest?.latencyMs, mode: latest?.mode, tracking: latest?.tracking,
        anchors: status.anchors, placed: status.placed, light: status.light,
        nativeLight: latest?.light ?? null,
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
