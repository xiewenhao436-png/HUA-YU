---
name: canvas
description: "打开和使用画屿本地无限画布，按项目整理 Codex 生成的图片。用于 /canvas、打开画布、收集图片和查看已有项目画布。"
---

# 画屿

Use this skill to open the local 画屿 board and keep generated images collected in the active project.

## Workflow

1. Open the native plugin sidebar with the `huayu.open_canvas` MCP tool. Discover the installed tool if it is deferred, then pass the active workspace's absolute `projectDir` and the current Codex `threadId` whenever available.
   - `open_canvas` defaults to `presentation: "sidebar"`. The tool result opens the MCP App directly beside the chat; no browser tab, localhost URL, HTTP port, or desktop UI automation is needed.
   - The conversation's plugin panel entrypoint opens a local saved-canvas launcher. Without a binding, choose an existing board or explicitly create one for a listed local conversation. Opening, reconnecting and browsing must not send a chat message or require a model turn.
   - Saved panels restore their persisted board through the current MCP process automatically. Transport session ids are temporary and must never be treated as permanent board links. After a local plugin upgrade, close/reopen the panel to load the new UI; restart Codex only if its plugin process still runs the previous code. Routine computer restarts must not require a chat message to repair the board.
   - Reuse the saved board returned by `open_canvas`, including its actual `projectDir`; it may live inside the workspace's organized `_codex/` task folder. Use that exact directory and thread for subsequent imports.
   - Opening never installs an update. Canvas state and images stay under the workspace's `canvas/` directory, with separate scopes for bound threads.
   - Repeat calls reuse the panel in the same chat. Do not open a browser after a successful sidebar call.
2. Keep the workspace and thread explicit for subsequent imports and operations. Without a thread binding, use the shared project default; never guess another chat's binding.
3. Browser compatibility fallback: only when the host lacks MCP App support, the plugin MCP tool is unavailable, or the user explicitly asks for a browser, run `node <plugin-root>/bin/codex-canvas.mjs open --project <workspace> --thread-id <thread-id>` (omit thread when unavailable), or call `open_canvas` with `presentation: "browser"`.
   - Reuse an existing exact-URL Codex in-app browser tab, or open the returned URL in the in-app browser.
   - If browser control is unavailable, return `[Open 画屿](<url>)` and report the limitation. Do not launch the OS default browser or use desktop UI automation.
4. When the user asks for image generation or image editing while this skill is active:
   - Use Codex `imagegen` for the image work.
   - Save or identify the generated image file path and keep the current Codex thread id attached to the canvas operation.
   - Immediately add the result to the canvas with `huayu.add_image`, or by running:
     `node <plugin-root>/bin/codex-canvas.mjs import <image-path> --project <workspace> --thread-id <thread-id>`.
   - If the exact output path is unclear, call `huayu.collect_recent_images` with the active workspace, or run:
     `node <plugin-root>/bin/codex-canvas.mjs collect --project <workspace> --thread-id <thread-id> --since-minutes 30 --limit 5`.
   - Default collection scans only `~/.codex/generated_images/<thread-id>`. Without a bound thread it is a safe no-op. Use explicit `roots` / `--from` only for a user-requested manual recovery scan.
   - Session-generated images are placed in a vertical column by generation batch. Multiple images from the same generation batch are aligned in one horizontal row.
   - Canvas-derived images, when collected with a `sourceObjectId`, are placed in a horizontal row to the right of the source image.
5. `Quick Edit`, `Remove BG`, `Expand`, `Edit Text`, and `Edit Elements` are implemented as background 画屿 jobs. They create a canvas placeholder immediately, run Codex/ImageGen through the matching 画屿 operation skill and bundled Codex App CLI, then replace the placeholder with the collected output.
6. `Edit Text` is a two-step interaction: first run text recognition and show the formatted editable text list in the canvas UI; after the user changes one or more fields and clicks Run, call imagegen to produce the edited PNG.
   - Text recognition should try local RapidOCR first when available. If local OCR is unavailable, fails, or returns no text, fall back to Codex vision recognition.
7. `Edit Elements` asks ImageGen for a low-detail instance segmentation map, then 画屿 locally splits the source image into four-channel transparent PNG object/text layers plus a residual background. 画屿 immediately imports the residual background and transparent object/text layers, stacks them to the right of the source image so they reconstruct the original composition, and continues a background-completion pass from the original image plus residual background in the background. When completion finishes, 画屿 replaces the existing background layer asset in place and refreshes that layer. Intermediate segmentation and raw completion images stay internal to the job and are not added to the canvas.
8. Canvas-to-chat requires a bound Codex thread. Each bound thread uses a separate canvas scope under `canvas/threads/<canvasId>/`. The frontend `send-to-chat` action sends a `localImage` turn through Codex app-server `thread/resume` + `turn/start`; MCP/HTTP callers may explicitly use `mention-file` for a Codex `@file`-style `mention` turn. The frontend `@file` toolbar button must not directly send a turn; it prepares/copies an `@<absolute-path>` reference for the user to paste into the Codex chat box. Do not use desktop UI automation or clipboard paste as a fallback.

## Notes

- 画屿 uses the technical plugin/MCP identifier `huayu`. Older Codex Canvas boards remain compatible: keep their exact `canvas/` paths, `codex-canvas.json`, persisted registry locations and `CODEX_CANVAS_*` variables. Renaming the product must not move or duplicate a user's saved board. The CLI filename `bin/codex-canvas.mjs` and legacy `ui://codex-canvas/` resource links remain supported for compatibility.
- The header canvas switcher lists saved boards in the current project's workspace, marks the active board, and opens a selected board directly. Its fixed “返回画布中心” entry shows the initial saved-board picker without automatically reopening the last board. Navigation does not import images or send chat turns; workers retain their explicitly assigned board.
- The canvas center groups saved boards by workspace project and provides project filters, search, sorting, thumbnails, and a fixed recycle-bin entry. A card's context menu / more button moves it to the recycle bin; an undo notification and the recycle-bin restore action return the intact board to its original project. This soft deletion retains files on disk.
- MCP UI resources and action handlers are one process generation. The center checks `libraryActions` before recycle-bin actions; missing capabilities indicate an old backend. Reconnecting or reopening only the panel cannot reload Node's action handlers. An “Unknown canvas library action” after an in-place update requires reloading the plugin process (or fully restarting Codex), then verifying the new runtime rather than repeatedly retrying the write.
- Permanent deletion is available only inside the recycle bin and requires the explicit confirmation dialog. It removes only that board's local canvas state, copied assets and job files; original project documents, outside source images and sibling boards are preserved. Active operations prevent permanent removal. If removal starts but a file is locked, the entry shows incomplete deletion and offers a confirmed retry; it cannot restore a partially removed board. Never permanently delete a board merely to resolve a connection issue.
- The native sidebar's “从其他会话导入” browser supports selecting images or importing a whole source board. It copies originals into the destination board, retains prompts and provenance, adds a pale source frame, and supports undo as one batch. Browsing/importing must not edit or rebind the source chat. User selection in this browser is not a request to message another conversation.
- The local canvas library stores lightweight board locations and chat title/cwd metadata. It does not read full chat history. AI workers still archive into their explicitly assigned board; viewing another board never silently redirects new image output.
- Canvas data is stored under `<workspace>/canvas/`.
- The default UI is a self-contained MCP App in the plugin sidebar. Its state, images, and actions use the app-only MCP transport; the local web service is a compatibility fallback.
- The first milestone should preserve generated images as project assets, not only as chat attachments.

- When a user asks to reuse project references, call `huayu.project_references` with the explicit workspace path. It returns five-star boards and bounded object details including image paths; inspect relevant content and images before applying them. This is an explicit lookup, not automatic context injection.
