#!/bin/bash
# Archive HoloWeb (app + embedded App Clip) and upload it to App Store Connect / TestFlight,
# without Xcode's account settings: an App Store Connect API key authenticates, and the export is
# signed manually with a local Apple Distribution identity (App Manager keys cannot cloud-sign).
#
# One-time setup:
#   - Team API key (App Store Connect -> Users and Access -> Integrations), App Manager or Admin:
#       ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8, and in ~/.zshrc (never commit them):
#       export ASC_KEY_ID=<KEYID> ASC_ISSUER_ID=<issuer uuid>
#   - "Apple Distribution: Holo Interactive US, Inc." identity in the login keychain, and App Store
#     profiles named "HoloWeb AppStore <bundle id>" for the app and the Clip (created through the API
#     with Scripts/asc-api.mjs on 2026-09-24; regenerate when the certificate expires on 2027-09-24).
# The app record (bundle ID org.realitydeslab.holoweb, "HoloWeb: WebXR for iPhone") must exist.
#
# Usage: Scripts/testflight.sh [--skip-upload]
# The build number is the current time (yymmddHHMM), so every run uploads a new, larger build.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ASC_KEY_ID:?set ASC_KEY_ID (App Store Connect API key ID)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (App Store Connect API issuer ID)}"
KEY="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
[ -f "$KEY" ] || { echo "missing API key file: $KEY" >&2; exit 1; }
KEYAUTH=(-authenticationKeyPath "$KEY" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

BUILD="$(date +%y%m%d%H%M)"
ARCHIVE="build/HoloWeb-$BUILD.xcarchive"

echo "== polyfill: test, build, sync"
(cd polyfill && npm test --silent && npm run typecheck --silent && npm run build --silent)
Scripts/sync-polyfill.sh >/dev/null

echo "== archive build $BUILD"
xcodebuild archive -project HoloWeb.xcodeproj -scheme HoloWeb -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" CURRENT_PROJECT_VERSION="$BUILD" \
  -allowProvisioningUpdates "${KEYAUTH[@]}" -quiet

cat > build/ExportOptions-upload.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>KR9H35SQQ9</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict>
    <key>org.realitydeslab.holoweb</key><string>HoloWeb AppStore org.realitydeslab.holoweb</string>
    <key>org.realitydeslab.holoweb.Clip</key><string>HoloWeb AppStore org.realitydeslab.holoweb.Clip</string>
  </dict>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><true/>
</dict></plist>
PLIST

if [ "${1:-}" = "--skip-upload" ]; then
  echo "archived $ARCHIVE (upload skipped)"
  exit 0
fi

echo "== export + upload"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist build/ExportOptions-upload.plist \
  -exportPath "build/export-$BUILD" "${KEYAUTH[@]}"
echo "uploaded build $BUILD; it appears in TestFlight after Apple's processing (10-30 min)"
