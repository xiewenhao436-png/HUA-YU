---
name: canvas-expand
description: "向外扩展画屿中选中的图片，并把扩展后的结果收集回画布。"
---

# 画屿 · 扩展画面

Use this skill when the user invokes Expand from 画屿 or asks to extend a selected canvas image beyond its current edges.

## Behavior

1. 画屿 first creates a padded PNG input using the selected scale, target ratio, and the user's final source-image position inside the preview frame. Treat the pasted original content as locked source content and the padded surroundings as the outpaint region.
2. Use the user's Expand preset, scale, ratio, and optional text as the primary expansion instruction.
3. Preserve the source subject identity, visible text, composition anchor, perspective, lighting, colors, and design intent.
4. Fill the padded surrounding area with coherent generated content. Do not leave blurred padding, blank margins, checkerboards, seams, or artificial borders in the final image.
5. Extend the scene or design outside the current frame. Do not crop, zoom in, replace the main subject, or redesign unrelated content.
6. Keep the original image content visually coherent with the newly generated surrounding area.
7. Save the final expanded image as a PNG under the 画屿 job output directory.
8. 画屿 will collect the output and place it in a row to the right of the source image.

Do not ask follow-up questions from a background Expand job. Make the most reasonable outpainted expansion from the provided instruction.
