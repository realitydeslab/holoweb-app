#!/usr/bin/env python3
"""Runs selected target groups from Scripts/regression_targets.py on the connected iPhone,
without the polyfill tests or Xcode builds (the installed app is used as-is).

    Scripts/run-targets.py threejs-bundled gallery [--device UDID]
    Scripts/run-targets.py --list
"""
from __future__ import annotations

import argparse
import sys
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import regression  # noqa: E402
from regression_targets import GROUPS  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("groups", nargs="*", help="group names from regression_targets.GROUPS")
    parser.add_argument("--device", help="iPhone UDID (default: first connected iOS 27+ phone)")
    parser.add_argument("--list", action="store_true", help="list groups and targets")
    args = parser.parse_args()
    if args.list or not args.groups:
        for name, targets in GROUPS.items():
            print(f"{name}: " + ", ".join(t.label for t in targets))
        return 0
    unknown = [g for g in args.groups if g not in GROUPS]
    if unknown:
        sys.exit(f"unknown group(s): {', '.join(unknown)}")
    device = args.device or regression.connected_ios27_device()
    if not device:
        sys.exit("no connected iOS 27+ iPhone")
    report = regression.Report()
    with import_module("device-lock").device_lock():
        for group in args.groups:
            print(f"\n[{group}]", flush=True)
            for target in GROUPS[group]:
                regression.third_party_run(report, device, target)
    passed = sum(ok for _, ok, _ in report.results)
    print(f"\n{passed}/{len(report.results)} checks passed", flush=True)
    for name, _, detail in report.failed:
        print(f"  FAILED {name}  {detail}")
    return 0 if not report.failed else 1


if __name__ == "__main__":
    sys.exit(main())
