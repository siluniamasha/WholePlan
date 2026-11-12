# WholePlan generated brand assets

Created with the built-in image_gen tool on 12 November 2026. The original generated PNGs are retained here. Exact generation and refinement prompts are in `prompts.json`.

- `mark-source.png` is the transparent blue ribbon W symbol used in headers, the sidebar and favicon derivatives.
- `hero-source.png` is the transparent concert-ticket, hotel-key and shuttle-card illustration used on the landing page and empty workspace.
- `social-source.png` is the landscape sharing banner with the same mark and illustration.

Production derivatives live in `public/assets`. The hero is served as 640 px and 1024 px WebP images with responsive selection. The small logo and favicon use PNG with alpha. The social preview is 1200 × 630 PNG. Build-time encoding and resizing used Sharp from the available tool runtime. The application requires no added runtime package.

The wordmark in the website remains live text so it stays sharp and accessible at every screen size.
