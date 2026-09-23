# HoloWeb app icon

`holoweb-icon.html` renders the icon with three.js: the HoloKit mark (Design/HoloKit/Asset 4.svg polygons)
extruded like cardboard, with a tilted orbit ring, after the 3D WebXR logo on immersiveweb.dev.

Current icon (`HoloWeb/Assets.xcassets/AppIcon.appiconset/AppIcon.png`, 1024x1024, no alpha):

```
holoweb-icon.html?zoom=0.62&bg=linear-gradient(160deg,%23241a5c,%235a2596)&face=%23ffffff&side=%23b9b3d6&ring=%2366d9ff&glow=0.6
```

Serve this folder (`python3 -m http.server`), open the URL in a 1024x1024 viewport and take a screenshot
(the page renders once and sets `window.done`). Parameters: `bg` (CSS background), `face`/`side` (mark
colours), `ring`/`glow`/`rr`/`rt`/`tx`/`ty`/`tz` (ring colour, emissive, radius, tube, tilt), `rx`/`ry`
(mark tilt), `depth`, `zoom`.
