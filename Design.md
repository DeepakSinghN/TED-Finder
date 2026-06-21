# Design System Reference — TED.com

A practical style guide distilled from ted.com, written for AI coding agents to follow when building or styling a similar site. Use this as the source of truth for visual decisions; don't invent colors, fonts, or spacing outside what's defined here.

---

## 1. Brand Personality

- **Tone:** Confident, editorial, intellectual but accessible. Never playful/cartoonish.
- **Mood:** High-contrast, bold, "big idea" energy. Lots of black/white with a single sharp accent color.
- **Density:** Content-dense but airy — large type and generous whitespace, not cluttered.

---

## 2. Color Palette

| Token | Hex | Usage |
|---|---|---|
| `--color-ted-red` | `#EB0028` | Primary accent — logo, CTAs, active states, highlights, hover underlines |
| `--color-black` | `#000000` | Primary text, header/footer backgrounds, dark-mode sections |
| `--color-white` | `#FFFFFF` | Page background, text-on-dark |
| `--color-gray-900` | `#1A1A1A` | Dark surface (cards on dark backgrounds) |
| `--color-gray-600` | `#5F5F5F` | Secondary/meta text (timestamps, view counts, tags) |
| `--color-gray-300` | `#D8D8D8` | Borders, dividers |
| `--color-gray-100` | `#F4F4F4` | Light surface / section background alternation |

**Rules:**
- Red is used **sparingly** — for one primary action or accent per view, never as a background for large areas.
- Default mode is white background / black text. Dark sections (hero banners, footer, video overlays) flip to black background / white text.
- No gradients, no drop shadows on color — flat color blocking only.

---

## 3. Typography

- **Typeface:** A grotesque/humanist sans-serif (TED uses a custom font similar to **Helvetica Neue / Atlas Grotesk**). Fallback stack:
  ```css
  font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
  ```
- **Headlines:** Extra-bold or bold weight, tight letter-spacing, large size, often ALL CAPS for nav/labels and sentence case for editorial headlines.
- **Body copy:** Regular weight, comfortable line-height (1.5–1.6), gray-900/black on white.
- **Scale (suggested):**

| Element | Size | Weight | Notes |
|---|---|---|---|
| H1 / Hero | 48–72px | 800 | Tight line-height (1.0–1.1) |
| H2 / Section title | 32–40px | 700 | |
| H3 / Card title | 18–22px | 700 | |
| Body | 16px | 400 | |
| Meta/label | 12–13px | 600 | Letter-spacing +0.05em, often uppercase |
| Nav links | 14px | 600 | Uppercase, letter-spacing +0.03em |

- Links inside body text are bold/underlined rather than colored, except primary CTAs which use red.

---

## 4. Layout & Grid

- **Max content width:** ~1280–1400px, centered, with fluid gutters (24–48px depending on breakpoint).
- **Grid:** 12-column responsive grid. Video/talk cards typically render in a 2 / 3 / 4-column grid depending on viewport (mobile / tablet / desktop).
- **Spacing scale:** Use a consistent 8px base unit (8, 16, 24, 32, 48, 64, 96) for all margin/padding — no arbitrary values.
- **Section rhythm:** Alternate white and light-gray (`--color-gray-100`) full-width bands to separate content sections; occasional full-bleed black sections for featured/hero content.

---

## 5. Navigation

- **Header:** Fixed/sticky, black or white background, logo top-left, primary nav center/left, search + account/CTA right.
- **Primary nav pattern:** Top-level categories (e.g., WATCH, DISCOVER, ATTEND, PARTICIPATE, ABOUT) behave as **mega-menu triggers** — hovering/clicking reveals a dropdown panel with grouped links, each with a short one-line description beneath the link label.
- **Mobile nav:** Collapses into a hamburger/full-screen overlay menu; same grouped structure, accordion-style sections.
- Active/hover nav state: red underline or red text, no background fill.

---

## 6. Core Components

### Video / Talk Card
- Thumbnail image (16:9), title (bold, 2-line clamp), speaker name (gray, smaller), optional duration/view-count badge bottom-right of thumbnail.
- On hover (desktop): subtle scale (1.02–1.04) or red play-icon overlay fade-in. No heavy shadow.

### Buttons
- **Primary:** Solid red background, white bold uppercase text, no border-radius or very slight (2–4px), generous horizontal padding.
- **Secondary:** Black or white outline button, transparent background, black/white text — fills solid on hover.
- **Ghost/text link:** Bold text + red underline on hover.

### Hero / Featured Banner
- Full-bleed image or video background, black overlay gradient at ~40–60% opacity for text legibility, large bold headline + short description + single CTA button, left-aligned text block.

### Footer
- Black background, white text, multi-column link groups (Explore / Our community / Newsletters / Legal), social icons row, app store badges, newsletter signup form (email input + red "Subscribe" button).

### Forms / Inputs
- Simple bordered rectangle, black border on white, red border/focus ring on focus. Labels above input, uppercase small caps style for labels.

---

## 7. Imagery & Iconography

- Photography: high-contrast, editorial, real human portraits/speakers on stage — never generic stock-photo gloss.
- Icons: simple line icons, 1.5–2px stroke, monochrome (black or white depending on background), no filled/glyph style.
- Video thumbnails always 16:9, never cropped to square.

---

## 8. Motion & Interaction

- Transitions: fast and subtle — 150–250ms ease for hover states, no bouncy/elastic easing.
- Dropdowns/menus: simple fade + slight vertical slide (8–12px), no slow reveals.
- Avoid parallax or heavy scroll-jacking effects; content should feel stable and fast.

---

## 9. Accessibility & Tone Guardrails

- Maintain WCAG AA contrast — red (#EB0028) on white passes for large text/buttons but should not be used for small body text on white.
- Always pair color cues (red) with a text/icon cue, not color alone.
- Keep copy concise, confident, and idea-led ("Ideas change everything" style headline voice) — avoid filler marketing language.

---

## 10. Quick Reference for Agents

When generating UI for this brand, default to:
1. White background, black text, one red accent per screen.
2. Bold, oversized headline type; uppercase nav/labels.
3. Card grids for content collections (talks, articles, episodes).
4. Flat design — no shadows, no gradients, minimal border-radius.
5. Black full-bleed sections for hero/footer.
6. Fast, subtle transitions only.

If a requirement isn't covered above, default to the most minimal, high-contrast, editorial choice rather than a decorative one.
