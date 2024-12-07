var originalLog = console.log;
console.log = function(message) {
    originalLog(message); // Continue to log to the browser console
    window.webkit.messageHandlers.logHandler.postMessage(String(message));
}

//console.log("holokit-ar.js loaded")

if (typeof WebXRPolyfill !== 'undefined' && !navigator.xr) {
    const polyfill = new WebXRPolyfill();
}

if (navigator.xr) {
    navigator.xr.isSessionSupported("immersive-ar").then((supported) => {
        if (supported) {
//            console.log("immersive-ar mode is supported")
        } else {
            console.log("immersive-ar mode is not supported")
        }
    });
} else {
    console.log("immersive-ar mode is not supported")
}
