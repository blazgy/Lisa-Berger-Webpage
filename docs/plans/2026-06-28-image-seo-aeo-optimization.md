# Image SEO/AEO Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable large image previews for search engines, add high-compatibility WebP preview images, and align all page image metadata to resolve missing search snippets.

**Architecture:** We will modify `index.html` head metadata (robots, OpenGraph, Twitter, and structured JSON-LD schemas) to point to the newly generated `Lisa-Photo-1.webp` file, and add a robots `max-image-preview:large` directive. We will also add a dedicated WebPage schema.

**Tech Stack:** HTML5, JSON-LD, WebP

---

### Task 1: Update Robots, OpenGraph, and Twitter Meta Tags

**Files:**
- Modify: `index.html:12-36`

**Step 1: Apply Robots and Image Meta updates**
Update [index.html](file:///Users/blazgyoha/Documents/Lisa%20Berger%20Webpage/index.html) as follows:
- Replace:
  ```html
  <meta name="robots" content="index, follow">
  ```
  with:
  ```html
  <meta name="robots" content="index, follow, max-image-preview:large">
  ```
- Replace both `og:image` and `twitter:image` tags so they point to `Lisa-Photo-1.webp` instead of `Lisa-Photo-2.avif`:
  ```html
  <meta property="og:image" content="https://www.psychotherapieberger.at/Lisa-Photo-1.webp">
  ```
  and
  ```html
  <meta property="twitter:image" content="https://www.psychotherapieberger.at/Lisa-Photo-1.webp">
  ```

**Step 2: Commit metadata updates**
Run:
```bash
git add index.html
git commit -m "feat: add max-image-preview directive and update preview images to webp fallbacks"
```

---

### Task 2: Update Schema Markup and Add WebPage Schema

**Files:**
- Modify: `index.html:42-83` (JSON-LD script blocks)

**Step 1: Update MedicalBusiness and Add WebPage Schema**
Update [index.html](file:///Users/blazgyoha/Documents/Lisa%20Berger%20Webpage/index.html) JSON-LD scripts:
- In the `MedicalBusiness` script block, change:
  ```json
  "image": "https://www.psychotherapieberger.at/Lisa-Photo-1.avif",
  ```
  to:
  ```json
  "image": "https://www.psychotherapieberger.at/Lisa-Photo-1.webp",
  ```
- Directly below the `MedicalBusiness` script block, add the new `WebPage` script block:
  ```html
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": "https://www.psychotherapieberger.at/#webpage",
    "url": "https://www.psychotherapieberger.at/",
    "name": "Praxis für Psychotherapie Vöcklabruck | Lisa Berger",
    "primaryImageOfPage": "https://www.psychotherapieberger.at/Lisa-Photo-1.webp"
  }
  </script>
  ```

**Step 2: Commit schema updates**
Run:
```bash
git add index.html
git commit -m "feat: align schema images and add WebPage schema with primaryImageOfPage"
```

---

### Task 3: Commit Newly Generated WebP Files

**Files:**
- Create: `Lisa-Photo-1.webp`
- Create: `Lisa-Photo-2.webp`

**Step 1: Commit files**
Add and commit the WebP files created via Python Pillow:
```bash
git add Lisa-Photo-1.webp Lisa-Photo-2.webp
git commit -m "assets: add high-compatibility WebP visual fallbacks for metadata"
```
