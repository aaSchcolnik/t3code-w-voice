# Desktop notification icons

The SVG files are the deterministic source assets. Electron loads the checked-in
transparent PNG files through `nativeImage.createFromPath`; no generated artwork
or runtime network access is involved.

Regenerate a PNG after changing its matching SVG with:

```sh
rsvg-convert --width 256 --height 256 --keep-aspect-ratio \
  --output provider.png provider.svg
```

`agent.svg` is the neutral fallback for an unknown provider. It intentionally
does not use T3 branding.

The provider glyphs mirror the badge-free dark-theme artwork used by the
Subagents panel. The colored two-letter badges identify T3 Code provider
instances and intentionally do not appear in native notifications.

Each glyph uses roughly 75% of its canvas so macOS notification text remains
legible when the system presents the image beside or partially beneath it.
