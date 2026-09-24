"""Third-party pages and log expectations for Scripts/regression.py (device stage).

Each group is a list of `Target`s run by `third_party_run`; `--only <substr,...>` selects groups
by name. How each page's Enter-AR control is reached is noted next to it.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Expect:
    """A log line a third-party run must produce: check name suffix, regex, hint if missing."""
    name: str
    pattern: str
    hint: str


@dataclass(frozen=True)
class Target:
    """A page to open and enter AR on. `url` without "://" is a bundled page (HOLOWEB_PAGE).
    `click` is a CSS selector (document, open shadow roots and same-origin iframes are searched)
    or "js:<expression>". `human` expectations are reported as INFO when absent."""
    label: str
    url: str
    click: str = "#ARButton"
    features: tuple[str, ...] = ()
    expect: tuple[Expect, ...] = ()
    human: tuple[Expect, ...] = ()
    ignore_errors: str | None = None
    seconds: int = 30


PLANES = Expect("planes", r"\[bridge\] planes sent n=\d+ polygons=[1-9]\d*",
                "no plane polygons: needs real surfaces in view, move the phone")
ENVIRONMENT = Expect("environment", r"\[bridge\] environment map sent [^\n]*", "no environment map sent")
HANDS = Expect("hands", r"\[bridge\] hands sent [^\n]*", "hand tracker never reported")
MESHES = Expect("meshes", r"\[bridge\] meshes sent n=[1-9][^\n]*",
                "no meshes: LiDAR needs geometry in view, move the phone")
SET_IMAGES = Expect("set-tracked-images", r"\[bridge\] setTrackedImages n=\d+ scores=(?:[a-z,]*,)?trackable[^\n]*",
                    "no setTrackedImages with a trackable score")
IMAGE_RUN = Expect("image-tracking-run", r"\[bridge\] image tracking n=[1-9]\d*", "ARKit never ran with detection images")
# Needs the printed/displayed marker in front of the camera; reported as INFO when absent.
IMAGE_TRACKED = Expect("image-tracked", r"\[bridge\] images sent [^\n]*tracked=true[^\n]*",
                       "needs a human: show the page's marker to the camera")
IFRAME = Expect("iframe-bridge", r"\[bridge\] ready \S+ \(iframe\)[^\n]*", "no same-origin iframe sent ready")
IMAGE_CHECKS = dict(features=("image-tracking",), expect=(SET_IMAGES, IMAGE_RUN), human=(IMAGE_TRACKED,))

THREE = "https://threejs.org/examples/"
IMMERSIVE_WEB = "https://immersive-web.github.io/webxr-samples/"
SAMPLE_BUTTON = "button.webvr-ui-button"  # WebXRButton from js/util/webxr-button.js
NEEDLE_AR = '[data-needle="webxr-ar-button"]'  # Needle Engine 4: inside <needle-menu>'s shadow root
PLAYCANVAS_FIRE_AR = ("js:window.pc && pc.Application.getApplication() && "
                      "(pc.Application.getApplication().fire('ar:request:start'), true)")
PLAYCANVAS_XRBASIC = ("js:(a => { const s = a && a.root.findComponents('script').find(c => c.xrBasic); "
                      "if (!s) return false; s.xrBasic.button.element.fire('click'); return true; })"
                      "(window.pc && pc.Application.getApplication())")

GROUPS: dict[str, list[Target]] = {
    "threejs": [
        Target("three-hittest", THREE + "webxr_ar_hittest.html"),
        Target("three-plane-detection", THREE + "webxr_ar_plane_detection.html",
               features=("plane-detection",), expect=(PLANES,)),
        Target("three-lighting", THREE + "webxr_ar_lighting.html",
               features=("light-estimation",), expect=(ENVIRONMENT,)),
    ],
    # The same three.js examples bundled under Web/examples/threejs (no network needed).
    "threejs-bundled": [
        Target("three-bundled-hittest", "examples/threejs/webxr_ar_hittest.html"),
        Target("three-bundled-plane-detection", "examples/threejs/webxr_ar_plane_detection.html",
               features=("plane-detection",), expect=(PLANES,)),
        Target("three-bundled-lighting", "examples/threejs/webxr_ar_lighting.html",
               features=("light-estimation",), expect=(ENVIRONMENT,)),
    ],
    # PlayCanvas runs the app in a same-origin iframe and draws its AR button on the canvas.
    "playcanvas": [
        Target("playcanvas-iframe", "https://playcanv.as/p/AOYF3YyG/", click=PLAYCANVAS_FIRE_AR, expect=(IFRAME,)),
    ],
    # engine.needle.tools/samples/image-tracking/ embeds the Needle app in a cross-origin iframe,
    # which the bridge refuses, so the app URL is tested directly.
    "image-tracking": [
        Target("playcanvas-image-tracking", "https://playcanv.as/p/PCsSvN5h/", click=PLAYCANVAS_XRBASIC, **IMAGE_CHECKS),
        Target("needle-image-tracking", "https://image-tracking-zubckszr0qj2.needle.run/", click=NEEDLE_AR,
               **IMAGE_CHECKS),
    ],
    "image-example": [
        Target("example-image-tracking", "examples/image-tracking.html?autostart&stats", click="js:true",
               **IMAGE_CHECKS),
        Target("example-image-tracking-button", "examples/image-tracking.html?stats", **IMAGE_CHECKS),
    ],
    # Gallery entries (https://holoweb.app/). For Needle pages, entered-ar shows whether Needle
    # takes the WebXR path or Quick Look under HoloWeb's user agent.
    "gallery": [
        Target("gallery-supersplat", "https://superspl.at/s?id=5c0f892e&webgl", click="button.sse-arMode",
               seconds=90),  # 182 MB splat; its AR button stays disabled until the splat has loaded
        Target("gallery-needle-physics", "https://physics-playground-zubcksgtkqf.needle.run/", click=NEEDLE_AR),
        Target("gallery-needle-snowglobe", "https://snowglobe-zubckszvui3a.needle.run/", click=NEEDLE_AR),
        Target("gallery-needle-musical", "https://musicalinstrument-zubcksz1usd7h.needle.run/", click=NEEDLE_AR),
        Target("gallery-needle-sandbox", "https://collaborativesandbox-zubcks1qdkhy.needle.run/", click=NEEDLE_AR),
        Target("gallery-needle-ring", "https://jewelry-ring-zubckszopxdy.needle.run/", click=NEEDLE_AR),
        # model-viewer's default AR button lives in its shadow root; the first <model-viewer ar>.
        Target("gallery-model-viewer", "https://modelviewer.dev/examples/augmentedreality/",
               click="#default-ar-button"),
        # Babylon's WebXR default experience: <button class="babylonVRicon"> in .xr-button-overlay.
        Target("gallery-babylon", "https://playground.babylonjs.com/full.html#GG06BQ#97",
               click=".xr-button-overlay button", seconds=75),
        # three.js XRButton offers immersive-ar first.
        Target("gallery-ballshooter", THREE + "webxr_xr_ballshooter.html", click="#XRButton",
               # The page's buildController() returns undefined for screen (tap) input sources, same in Chrome Android.
               ignore_errors=r"Object3D\.add: object not an instance of THREE\.Object3D"),
    ],
    # (path, required requestSession features, expected log lines). Known gaps per page are in
    # plan/samples_requirements.md. tests/interrupted-ar deliberately throws `new Exception(...)`.
    "immersive-web": [
        Target("iw-mesh-detection", IMMERSIVE_WEB + "proposals/mesh-detection.html", click=SAMPLE_BUTTON,
               features=("mesh-detection",), expect=(MESHES,)),
        Target("iw-plane-detection", IMMERSIVE_WEB + "proposals/plane-detection.html", click=SAMPLE_BUTTON,
               features=("plane-detection",), expect=(PLANES,)),
        Target("iw-webgpu-ar-session", IMMERSIVE_WEB + "webgpu/immersive-ar-session.html", click=SAMPLE_BUTTON,
               features=("webgpu",)),
        Target("iw-webgpu-hands", IMMERSIVE_WEB + "webgpu/immersive-hands.html", click=SAMPLE_BUTTON,
               features=("hand-tracking",), expect=(HANDS,)),
        Target("iw-anchors", IMMERSIVE_WEB + "anchors.html", click=SAMPLE_BUTTON, features=("anchors",)),
        Target("iw-hit-test", IMMERSIVE_WEB + "hit-test.html", click=SAMPLE_BUTTON, features=("hit-test",)),
        Target("iw-hit-test-anchors", IMMERSIVE_WEB + "hit-test-anchors.html", click=SAMPLE_BUTTON,
               features=("hit-test", "anchors")),
        Target("iw-hands", IMMERSIVE_WEB + "immersive-hands.html", click=SAMPLE_BUTTON,
               features=("hand-tracking",), expect=(HANDS,)),
        Target("iw-interrupted-ar", IMMERSIVE_WEB + "tests/interrupted-ar.html", click=SAMPLE_BUTTON,
               ignore_errors=r"Can't find variable: Exception"),
        Target("iw-exit-button", IMMERSIVE_WEB + "tests/exit-button.html", click=SAMPLE_BUTTON),
    ],
}
