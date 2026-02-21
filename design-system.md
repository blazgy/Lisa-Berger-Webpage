# Lisa Berger - Webpage Design System

## 1. Color Palette

The core color palette consists of soft, earthy, and neutral tones. They convey a sense of calm, growth, and professional safety—fitting for a psychotherapy practice based on the humanistic, person-centered approach.

| Color Name | Hex Code | Usage |
| :--- | :--- | :--- |
| **Warm Sand / Gold** | `#F5DF9C` | Primary accent. Good for highlights, buttons (with dark text for contrast), or subtle background blocks. |
| **Soft Sage Green** | `#B3DAB6` | Secondary accent. Excellent for conveying growth and calm. Good for highlights or secondary buttons. |
| **Off-White / Light Gray** | `#F5F5F7` | Main background color. Provides a softer alternative to pure white, reducing eye strain. |
| **Pure White** | `#FFFFFF` | Used for cards, content blocks, or areas needing high contrast against the `Off-White` background. |
| **Text Dark (Generated)** | `#2B2B2B` | Default text color (Suggested). Never use pure black (`#000000`) for large bodies of text as it creates harsh contrast. |

---

## 2. Accessibility Notes (WCAG 2.1)
- **Text on Color blocks:** When placing text on the `#F5DF9C` (Sand) or `#B3DAB6` (Sage) backgrounds, use a **dark text color** (like `#2B2B2B`) to ensure the contrast ratio meets the 4.5:1 minimum standard. White text on these colors will fail accessibility contrast checks.
- **Focus States:** Remember to maintain visible focus outlines for interactive elements (e.g., buttons, links) across the site.

---

## 3. Typography (Lumos Framework V2)

The typography pairs a modern, approachable sans-serif with a warm, classic serif to create a professional yet highly empathetic tone. Classes follow the Lumos Framework fluid sizing methodology.

| Use Case | Font Family | Import Setup (Google Fonts) |
| :--- | :--- | :--- |
| **Headings (Headers, Titles)** | `Epilogue` | `<link href="https://fonts.googleapis.com/css2?family=Epilogue:wght@400;500;600;700&display=swap" rel="stylesheet">` |
| **Body Text (Paragraphs, Content)**| `Lora` | `<link href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">` |

### Font Hierarchy & Utility Classes
- **H1 (Hero/Main Title)**: `Epilogue`, Utility Class: `u-text-style-h1` (Bold/Semi-bold)
- **H2 (Section Titles)**: `Epilogue`, Utility Class: `u-text-style-h2` (Medium/Semi-bold)
- **H3 (Subsections)**: `Epilogue`, Utility Class: `u-text-style-h3` (Medium)
- **Body / Paragraphs**: `Lora`, Utility Class: `u-text-style-main`. *WCAG 2.1 Note: Ensure body text `line-height` is at least `1.5`.*
- **Blockquotes / Small text**: `Lora` (Italic) or `u-text-style-small`.

**Lumos Modifiers:**
- Weights: `u-weight-regular`, `u-weight-medium`, `u-weight-bold`
- Alignment: `u-text-align-center`, `u-text-align-start`

---

## 4. Layout, Spacing & The Lumos Framework

We are utilizing the **Lumos Framework** structure to ensure our code is scalable and our layout is "breakpointless" (fluidly adapting to any screen size without relying purely on rigid media queries).

### Page Structure
```html
<div class="page_wrap">
  <!-- Nav Component -->
  <main class="main_wrapper">
    <section class="section_{name}">
      <div class="u-container">
        <!-- Content goes here -->
      </div>
    </section>
  </main>
  <!-- Footer Component -->
</div>
```

### Grid & Flex Layout Attributes
Lumos V2 relies heavily on semantic data attributes (`[lumos="..."]`) for layouts to keep the CSS classes clean and separated from structural logic.

- **Grid:** Use `class="u-grid"` combined with data attributes for columns:
  - `[data-large-columns="12"]` (Desktop)
  - `[data-medium-columns="2"]` (Tablet/Smaller screens)
  - `[data-small-columns="1"]` (Mobile)
- **Flex:** Use `class="u-flex"` combined with:
  - `[data-direction="vertical"]` or `[data-direction="horizontal"]`
  - `[data-justify="center"]` or `[data-align="center"]`

### Spacing System (Fluid)
Spacing operates on a numeric scale using responsive CSS clamp/calc.
- **Padding:** `u-padding-[size]` (e.g. `u-padding-4`), `u-padding-inline-[size]`, `u-padding-block-[size]`
- **Margins:** `u-margin-bottom-[size]`, `u-margin-top-[size]`
- **Gap:** `u-gap-[size]` (e.g. `u-gap-2`)

*Note: Global spacing is managed by the root `--site-margin` variable to ensure content never collides with the browser window edge.*
