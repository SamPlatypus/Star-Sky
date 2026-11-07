# Fourier Epicycles Toy (offline)

A touch-friendly toy that redraws a shape with a chain of spinning circles
(a Fourier series). Pick a preset (heart, star, infinity, spiral) or tap
**Draw Custom** and draw your own shape with a finger or the mouse.

## Run it

`index.html` is one self-contained file. Open it in any modern browser
(double-click it, or copy it to your phone and open it there). It needs no
internet connection, server or install.

## What was changed from the original page

- The Tailwind Play CDN script was replaced by the same Tailwind v3 CSS,
  pre-built for the classes the page uses and inlined in a `<style>` tag.
- The Google Fonts link was replaced by the Inter font (weights 300–700)
  embedded in the file as WOFF2.
- One bug fix: the Fourier transform now measures points from the canvas
  centre. Before, the centre offset was counted twice, so shapes were drawn
  off-screen at the bottom-right corner.

Nothing else was changed.

## Rebuilding

`build/source.html` is the editable page. To regenerate `index.html` after
editing it (needs Node.js and a one-time internet connection for `npm install`):

```sh
cd build
npm install
npm run build
```
