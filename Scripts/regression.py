#!/usr/bin/env python3
"""HoloWeb regression suite.

Runs, in order:
  1. polyfill: typecheck, unit tests, headless-browser e2e, bundle build + sync into the app
  2. Xcode: builds the HoloWeb app (with embedded App Clip) and the HoloWebClip scheme
  3. device (only if an iOS 27 iPhone is connected): installs the app and runs every on-device
     check with explicit pass/fail thresholds.

Usage:
  Scripts/regression.py                 # everything; device stage auto-detects a phone
  Scripts/regression.py --skip-polyfill # native + device only
  Scripts/regression.py --device <UDID> # pick a specific phone
  Scripts/regression.py --no-device     # CI-style: polyfill + builds only

Exit code 0 only if every executed check passed. Stdlib only.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POLYFILL = ROOT / "polyfill"
BUNDLE_ID = "org.realitydeslab.holoweb"
MIN_FPS = 55.0


@dataclass
class Report:
    results: list[tuple[str, bool, str]] = field(default_factory=list)

    def add(self, name: str, ok: bool, detail: str = "") -> None:
        self.results.append((name, ok, detail))
        print(f"  {'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)

    @property
    def failed(self) -> list[tuple[str, bool, str]]:
        return [r for r in self.results if not r[1]]


def run(cmd: list[str], cwd: Path = ROOT, timeout: int = 1800) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, timeout=timeout)


def tail(text: str, n: int = 15) -> str:
    return "\n".join(text.strip().splitlines()[-n:])


# ---------------------------------------------------------------- stage 1: polyfill

def stage_polyfill(report: Report) -> None:
    print("\n[1/3] polyfill", flush=True)
    if not (POLYFILL / "node_modules").exists():
        run(["npm", "ci"], cwd=POLYFILL)
    for name, cmd in [("polyfill.typecheck", ["npm", "run", "typecheck"]),
                      ("polyfill.unit", ["npm", "test"]),
                      ("polyfill.e2e", ["npm", "run", "test:e2e"])]:
        proc = run(cmd, cwd=POLYFILL)
        out = proc.stdout + proc.stderr
        summary = re.findall(r"Tests\s+(\d+ passed[^\n]*)|(\d+/\d+ (?:passed|cases)[^\n]*)", out)
        detail = next((a or b for a, b in summary), "") if summary else ""
        report.add(name, proc.returncode == 0, detail or ("" if proc.returncode == 0 else tail(out)))
    proc = run([str(ROOT / "Scripts" / "sync-polyfill.sh")])
    size = re.search(r"holoweb-polyfill\.js:\s*([\d.]+ KB)", proc.stdout)
    report.add("polyfill.build+sync", proc.returncode == 0, size.group(1) if size else tail(proc.stderr))


# ---------------------------------------------------------------- stage 2: builds

def xcodebuild(scheme: str, destination: str) -> subprocess.CompletedProcess[str]:
    return run(["xcodebuild", "-project", "HoloWeb.xcodeproj", "-scheme", scheme,
                "-destination", destination, "-allowProvisioningUpdates", "build"])


def stage_build(report: Report, device: str | None) -> None:
    print("\n[2/3] Xcode builds", flush=True)
    dest = f"id={device}" if device else "generic/platform=iOS"
    for scheme in ["HoloWeb", "HoloWebClip"]:
        proc = xcodebuild(scheme, dest)
        errors = sorted(set(re.findall(r"^.*error:.*$", proc.stdout, re.M)))
        report.add(f"build.{scheme}", proc.returncode == 0, "; ".join(errors[:3]))


# ---------------------------------------------------------------- stage 3: device

def connected_ios27_device() -> str | None:
    proc = run(["xcrun", "xctrace", "list", "devices"])
    for line in proc.stdout.splitlines():
        m = re.match(r"^(.*) \((\d+)\.[\d.]*\) \(([0-9A-F-]{20,})\)$", line.strip())
        if m and "Simulator" not in line and int(m.group(2)) >= 27:
            state = run(["xcrun", "devicectl", "list", "devices"]).stdout
            if any(m.group(3) in l and "connected" in l for l in state.splitlines()):
                return m.group(3)
    return None


def app_path() -> Path:
    proc = run(["xcodebuild", "-project", "HoloWeb.xcodeproj", "-scheme", "HoloWeb", "-destination",
                "generic/platform=iOS", "-showBuildSettings"])
    folder = re.search(r"^\s*CODESIGNING_FOLDER_PATH = (.+)$", proc.stdout, re.M)
    if not folder:
        raise RuntimeError("cannot locate built HoloWeb.app")
    return Path(folder.group(1).strip())


def launch(device: str, env: dict[str, str], seconds: int) -> str:
    """Launches the app with env vars, streams its console for `seconds`, returns the log."""
    cmd = ["timeout", str(seconds), "xcrun", "devicectl", "device", "process", "launch", "--console",
           "--terminate-existing", "--environment-variables", json.dumps(env), "--device", device, BUNDLE_ID]
    proc = subprocess.run(cmd, text=True, capture_output=True)
    return proc.stdout + proc.stderr


def page_checks(report: Report, device: str, page: str, seconds: int, expected: list[str]) -> None:
    log = launch(device, {"HOLOWEB_PAGE": page}, seconds)
    seen: dict[str, tuple[bool, str]] = {}
    for m in re.finditer(r"\[check\] (PASS|FAIL) (\S+) ?([^\n]*)", log):
        seen[m.group(2)] = (m.group(1) == "PASS", m.group(3).strip())
    for name in expected:
        ok, detail = seen.get(name, (False, "no result (page did not reach this check)"))
        report.add(f"device.{name}", ok, detail)


def toggle_run(report: Report, device: str, page: str, label: str, seconds: int = 26) -> None:
    """Enters AR, lets the debug toggle flip mono/stereo every 6 s, checks fps and view counts."""
    log = launch(device, {"HOLOWEB_PAGE": page, "HOLOWEB_TEST_TOGGLE": "6"}, seconds)
    toggles = re.findall(r"\[state\] mode -> (mono|stereo)", log)
    samples = []
    for line in re.findall(r"\[ar-scene\] (\{.*\})", log):
        try:
            samples.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    steady = samples[1:]  # first sample includes session start-up
    report.add(f"device.{label}.entered-ar", "phase -> arMono" in log)
    report.add(f"device.{label}.toggled", len(toggles) >= 3, f"{len(toggles)} toggles")
    if not steady:
        report.add(f"device.{label}.stats", False, "no [ar-scene] stats")
        return
    worst = min(s.get("xrFps", 0) for s in steady)
    report.add(f"device.{label}.fps", worst >= MIN_FPS, f"min {worst} (>= {MIN_FPS})")
    # activeViews counts views with a non-zero viewport; a blank second view may stay after a
    # stereo -> mono switch (engines like three r111 assume a fixed view count per session).
    mismatched = [s for s in steady
                  if s.get("activeViews", s.get("views")) != (2 if s.get("mode") == "stereo" else 1)]
    report.add(f"device.{label}.views-follow-mode", not mismatched,
               f"{len(steady)} samples" if not mismatched else f"{len(mismatched)} mismatched")
    errors = sorted({e for s in steady for e in s.get("errors", [])})
    report.add(f"device.{label}.no-page-errors", not errors, "; ".join(errors[:2]))


def third_party_run(report: Report, device: str, url: str, label: str, seconds: int = 30) -> None:
    """Opens a third-party WebXR page, presses its three.js ARButton, checks AR entry and streaming."""
    log = launch(device, {"HOLOWEB_URL": url, "HOLOWEB_TEST_CLICK": "#ARButton"}, seconds)
    name = f"device.{label}"
    clicked = re.search(r"\[test\] (clicked|no element) (.*)", log)
    report.add(f"{name}.clicked", bool(clicked) and clicked.group(1) == "clicked",
               clicked.group(0) if clicked else "no [test] line (page never finished loading?)")
    report.add(f"{name}.entered-ar", "phase -> arMono" in log)
    stats = [(int(p), int(s)) for p, s in re.findall(r"\[bridge\] ARKit .* pushed (\d+), skipped (\d+)", log)]
    if stats:
        pushed, skipped = stats[-1]
        report.add(f"{name}.frames", pushed > 0 and skipped <= 0.1 * pushed,
                   f"pushed {pushed}, skipped {skipped} (<= 10%)")
    else:
        report.add(f"{name}.frames", False, "no [bridge] ARKit stats line")
    # Deprecation notices arrive as "warn:" and are ignored.
    errors = re.findall(r"\[web\] (?:error|uncaught|unhandledrejection): ([^\n]*)", log)
    report.add(f"{name}.no-page-errors", not errors, "; ".join(e[:120] for e in errors[:2]))
    features_line = re.search(r"\[bridge\] requestSession features=([^\n]*)", log)
    features = features_line.group(1).strip().split(",") if features_line else []
    if label == "three-plane-detection":
        report.add(f"{name}.feature", "plane-detection" in features, ",".join(features) or "no requestSession")
        polygons = [(int(n), int(v)) for n, v in re.findall(r"\[bridge\] planes sent n=(\d+) polygons=(\d+)", log)]
        best = max(polygons, key=lambda nv: nv[1], default=(0, 0))
        report.add(f"{name}.planes", best[1] > 0,
                   f"max n={best[0]} polygons={best[1]}" if best[1] else
                   f"no plane polygons ({len(polygons)} sends): needs real surfaces in view, move the phone")
    elif label == "three-lighting":
        report.add(f"{name}.feature", "light-estimation" in features, ",".join(features) or "no requestSession")
        env = re.search(r"\[bridge\] environment map sent ([^\n]*)", log)
        report.add(f"{name}.environment", bool(env), env.group(1) if env else "no environment map sent")


def stage_device(report: Report, device: str) -> None:
    print(f"\n[3/3] device {device}", flush=True)
    install = run(["xcrun", "devicectl", "device", "install", "app", "--device", device, str(app_path())])
    report.add("device.install", install.returncode == 0, tail(install.stderr, 3) if install.returncode else "")
    if install.returncode:
        return

    page_checks(report, device, "webgpu-check.html", 14, [
        "webgpu.navigator-gpu", "webxr.navigator-xr", "webkit.create-js-handle",
        "webgl2.draw", "webgpu.copy-to-canvas-presenter"])
    page_checks(report, device, "bridge-check.html", 34, [
        "bridge.jshandle", "bridge.device-info", "bridge.frame-rate", "bridge.latency-p50",
        "bridge.raf-rate", "bridge.frame-args", "bridge.hit-test-reply", "bridge.hit-test-rejects-nan",
        "bridge.anchor-roundtrip", "bridge.anchor-rejects-nonfinite", "bridge.iframe-rejected",
        "bridge.unknown-type-rejected", "bridge.end-session-stops-frames"])
    page_checks(report, device, "xr-anchor-check.html", 16, [
        "xr.anchor-created", "xr.anchor-tracked-pose", "xr.anchor-deleted"])
    # Plane checks need real surfaces in view; a phone lying still on a desk sees none.
    page_checks(report, device, "env-plane-check.html", 30, [
        "env.received", "env.shape", "env.not-blank", "env.rate", "planes.received",
        "planes.polygon-shape", "planes.polygon-ccw", "planes.polygon-in-extent", "planes.last-changed"])

    toggle_run(report, device, "examples/three-ar.html?autostart", "three-webgl")
    toggle_run(report, device, "examples/three-ar-webgpu.html?autostart", "three-webgpu")

    examples = "https://threejs.org/examples/"
    third_party_run(report, device, examples + "webxr_ar_hittest.html", "three-hittest")
    third_party_run(report, device, examples + "webxr_ar_plane_detection.html", "three-plane-detection")
    third_party_run(report, device, examples + "webxr_ar_lighting.html", "three-lighting")

    log = launch(device, {"HOLOWEB_PAGE": "examples/demo.html"}, 10)
    report.add("device.browsing-without-session",
               "phase -> browsing" in log and "phase -> arMono" not in log)

    target = "https://immersive-web.github.io/webxr-samples/immersive-ar-session.html"
    link = "https://holoweb.app/launch?url=" + target.replace(":", "%3A").replace("/", "%2F")
    log = launch(device, {"HOLOWEB_URL": link}, 12)
    report.add("device.in-app-link-interception", f"[state] load {target}" in log)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--device", help="UDID of the iPhone to test on (default: first connected iOS 27+ phone)")
    parser.add_argument("--no-device", action="store_true", help="skip the on-device stage")
    parser.add_argument("--skip-polyfill", action="store_true", help="skip polyfill tests/build")
    args = parser.parse_args()

    report = Report()
    device = None if args.no_device else (args.device or connected_ios27_device())
    if not args.skip_polyfill:
        stage_polyfill(report)
    stage_build(report, device)
    if device and not report.failed:
        stage_device(report, device)
    elif device:
        print("\n[3/3] device stage skipped: earlier stages failed", flush=True)
    else:
        print("\n[3/3] device stage skipped: no connected iOS 27+ iPhone", flush=True)

    passed = sum(ok for _, ok, _ in report.results)
    print(f"\n{passed}/{len(report.results)} checks passed", flush=True)
    for name, _, detail in report.failed:
        print(f"  FAILED {name}  {detail}")
    return 0 if not report.failed else 1


if __name__ == "__main__":
    sys.exit(main())
