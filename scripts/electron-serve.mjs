// Serve dist-electron/ the way the packaged app does, without launching
// Electron. Handy for poking the build in a normal browser:
//
//   npm run build:electron && npm run electron:serve
import './../electron/server-process.mjs';
