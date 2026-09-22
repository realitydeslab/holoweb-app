"""Third-party pages and log expectations for Scripts/regression.py (device stage)."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Expect:
    """A log line a third-party run must produce: check name suffix, regex, hint if missing."""
    name: str
    pattern: str
    hint: str


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

IMMERSIVE_WEB = "https://immersive-web.github.io/webxr-samples/"
SAMPLE_BUTTON = "button.webvr-ui-button"  # WebXRButton from js/util/webxr-button.js
# (path, label, required requestSession features, expected log lines). Known gaps per page are
# listed in plan/samples_requirements.md.
IMMERSIVE_WEB_SAMPLES: list[tuple[str, str, tuple[str, ...], tuple[Expect, ...]]] = [
    ("proposals/mesh-detection.html", "iw-mesh-detection", ("mesh-detection",), (MESHES,)),
    ("proposals/plane-detection.html", "iw-plane-detection", ("plane-detection",), (PLANES,)),
    ("webgpu/immersive-ar-session.html", "iw-webgpu-ar-session", ("webgpu",), ()),
    ("webgpu/immersive-hands.html", "iw-webgpu-hands", ("hand-tracking",), (HANDS,)),
    ("anchors.html", "iw-anchors", ("anchors",), ()),
    ("hit-test.html", "iw-hit-test", ("hit-test",), ()),
    ("hit-test-anchors.html", "iw-hit-test-anchors", ("hit-test", "anchors"), ()),
    ("immersive-hands.html", "iw-hands", ("hand-tracking",), (HANDS,)),
    ("tests/interrupted-ar.html", "iw-interrupted-ar", (), ()),
    ("tests/exit-button.html", "iw-exit-button", (), ()),
]


# tests/interrupted-ar deliberately throws (`new Exception(...)`) right after requestSession.
SAMPLE_INTENDED_ERRORS = {"iw-interrupted-ar": r"Can't find variable: Exception"}
