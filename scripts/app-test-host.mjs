// Headless MCP host fixture. It cannot send chat turns or access OS clipboard.
export async function mountApp(page, client, { opened, html }) {
  await page.exposeFunction("mcpRequest", params => client.request("tools/call", params));
  await page.setContent('<style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts allow-downloads"></iframe>');
  await page.evaluate(({ opened, html }) => {
    window.chatMessages = []; window.downloads = [];
    window.addEventListener("message", async event => {
      const message = event.data;
      if (message?.jsonrpc !== "2.0") return;
      if (message.method === "ui/notifications/initialized") { if (opened) event.source.postMessage({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: opened }, "*"); return; }
      if (message.id === undefined) return;
      try {
        let result = {};
        if (message.method === "ui/initialize") result = { protocolVersion: message.params.protocolVersion, hostInfo: { name: "Canvas headless host", version: "1" }, hostCapabilities: { serverTools: {}, downloadFile: {}, message: {} }, hostContext: { displayMode: "fullscreen", availableDisplayModes: ["fullscreen"], theme: "light" } };
        else if (message.method === "tools/call") result = await window.mcpRequest(message.params);
        else if (message.method === "ui/download-file") window.downloads.push(message.params);
        else if (message.method === "ui/message") { window.chatMessages.push(message.params); throw new Error("Tests prohibit chat turns"); }
        event.source.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
      } catch (error) { event.source.postMessage({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } }, "*"); }
    });
    document.querySelector("iframe").srcdoc = html.replace('<meta charset="utf-8" />', '<meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'">');
  }, { opened, html });
  return page.frames()[1];
}
