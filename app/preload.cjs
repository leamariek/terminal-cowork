const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cowork', {
  platform: process.platform,
  plain: process.env.COWORK_PLAIN === '1',
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, fn) => ipcRenderer.on(channel, (_e, data) => fn(data)),
});
