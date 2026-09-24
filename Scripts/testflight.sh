#!/bin/bash
# Archive HoloWeb (app + embedded App Clip) and upload it to App Store Connect / TestFlight,
# without Xcode's account settings: signs and uploads with an App Store Connect API key.
#
# One-time setup (App Store Connect -> Users and Access -> Integrations -> App Store Connect API,
# a Team key with the App Manager role):
#   mkdir -p ~/.appstoreconnect/private_keys && mv AuthKey_<KEYID>.p8 ~/.appstoreconnect/private_keys/
#   export ASC_KEY_ID=<KEYID> ASC_ISSUER_ID=<issuer uuid>     # e.g. in ~/.zshrc; never commit them
# The app record (bundle ID org.realitydeslab.holoweb) must already exist in App Store Connect.
#
# Usage: Scripts/testflight.sh [--skip-upload]
# The build number is the current time (yymmddHHMM), so every run uploads a new, larger build.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${ASC_KEY_ID:?set ASC_KEY_ID (App Store Connect API key ID)}"
: "${ASC_ISSUER_ID:?set ASC_ISSUER_ID (App Store Connect API issuer ID)}"
KEY="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
[ -f "$KEY" ] || { echo "missing API key file: $KEY" >&2; exit 1; }
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$KEY" -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")

BUILD="$(date +%y%m%d%H%M)"
ARCHIVE="build/HoloWeb-$BUILD.xcarchive"

echo "== polyfill: test, build, sync"
(cd polyfill && npm test --silent && npm run typecheck --silent && npm run build --silent)
Scripts/sync-polyfill.sh >/dev/null

echo "== archive build $BUILD"
xcodebuild archive -project HoloWeb.xcodeproj -scheme HoloWeb -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" CURRENT_PROJECT_VERSION="$BUILD" \
  "${AUTH[@]}" -quiet

cat > build/ExportOptions-upload.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>KR9H35SQQ9</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>testFlightInternalTestingOnly</key><true/>
</dict></plist>
EOF

if [ "${1:-}" = "--skip-upload" ]; then
  echo "archived $ARCHIVE (upload skipped)"
  exit 0
fi

echo "== export + upload"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist build/ExportOptions-upload.plist \
  -exportPath "build/export-$BUILD" "${AUTH[@]}"
echo "uploaded build $BUILD; it appears in TestFlight after Apple's processing (10-30 min)"
