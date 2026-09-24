# web.holokit.io server files

Files in this directory are deployed to the `web.holokit.io` web server. They are not part of the iOS build.

## Apple App Site Association

`.well-known/apple-app-site-association` must be served at:

```
https://web.holokit.io/.well-known/apple-app-site-association
```

Requirements:

- HTTPS with a valid certificate, no redirects.
- `Content-Type: application/json`.
- File name has no extension. Do not rename it to `.json`.

Apple fetches the file through its CDN (`https://app-site-association.cdn-apple.com/a/v1/web.holokit.io`), so changes can take up to a day to reach devices. For development builds, append `?mode=developer` to the associated domain entry, or enable Settings > Developer > Associated Domains Development on the device.

What the file declares:

- `applinks`: the full app (`KR9H35SQQ9.org.realitydeslab.holokit-web`) opens links matching `/c*`, for example `https://web.holokit.io/c?url=https%3A%2F%2Fweb.holokit.io%2Ftest2%2F`.
- `appclips`: the App Clip (`KR9H35SQQ9.org.realitydeslab.holokit-web.Clip`) may be invoked from `web.holokit.io` URLs.

The matching entitlements are in `HoloWeb/HoloWeb.entitlements` (`applinks:web.holokit.io`, `appclips:web.holokit.io`) and `HoloWeb/HoloWebClip.entitlements` (`appclips:web.holokit.io`).

Check the deployed file:

```sh
curl -sI https://web.holokit.io/.well-known/apple-app-site-association | grep -i content-type
curl -s https://app-site-association.cdn-apple.com/a/v1/web.holokit.io
```

## Safari smart banner

Pages on `web.holokit.io` that should offer the App Clip include this tag in `<head>`:

```html
<meta name="apple-itunes-app" content="app-clip-bundle-id=org.realitydeslab.holokit-web.Clip, app-id=APP_STORE_ID">
```

Replace `APP_STORE_ID` with the numeric Apple ID of the full app from App Store Connect (App Information > Apple ID). The banner opens the App Clip card for the current page URL, so the page's own URL should be a `https://web.holokit.io/c?url=...` link, or the banner should be placed on pages served under `/c`.

## App Store Connect steps

1. Upload a build of the full app `HoloWeb` (it embeds `HoloWebClip`) and select it on the app version page.
2. Default App Clip experience: in the App Clip section of the version page, set the header image (1800x1200 PNG/JPG), subtitle, and call-to-action verb (for example "Open"). This experience is used for the Safari banner and for Messages links.
3. Advanced App Clip experience: App Clip > Advanced App Clip Experiences > add an experience with invocation URL `https://web.holokit.io/c`. Apple matches by URL prefix, so this covers `https://web.holokit.io/c?url=...`. Set title, subtitle, header image, and action. Leave location unset unless the experience is tied to a place.
4. Invocation policy: if only digital invocations are used (Safari banner, Messages, Maps, links), the App Clip may be up to 100 MB uncompressed on iOS 17 and later. App Clip Codes, NFC tags, or QR codes require the 15 MB limit.
5. After App Store Connect validates the AASA file (status shown next to the domain), test the invocation through TestFlight: App Clip testing > add an invocation URL `https://web.holokit.io/c?url=https%3A%2F%2Fweb.holokit.io%2Ftest2%2F`.


## Deployment status (2026-09-22)
The live copy lives in the website repo (realitydeslab/holoweb-website, `public/.well-known/apple-app-site-association`), deployed to GitHub Pages on push to main. This folder mirrors it. The earlier live file used `U3TS5VT3H8` (a personal certificate ID) instead of team `KR9H35SQQ9`, so links never matched; fixed. Both `/launch?url=` and `/c?url=` are claimed. GitHub Pages serves the file as `application/octet-stream`; Apple's CDN (app-site-association.cdn-apple.com) accepts that and caches for up to a day.
