# Design Document: Image SEO & AEO Optimization

## Context & Purpose
In search engine result pages (SERPs), thumbnail images do not currently appear next to the site’s search listing. To fix this and improve discoverability:
- We need to grant search bots explicit permission to display large images.
- We must provide highly compatible formats (WebP fallbacks) for crawlers that do not support modern AVIF files (like messaging previews or older indexers).
- We must align all page image metadata (`og:image`, `twitter:image`, and Schema.org schemas) to refer to the same primary preview image.

## Solution

1. **Convert primary visuals to WebP:**
   Generate `Lisa-Photo-1.webp` and `Lisa-Photo-2.webp` from their respective high-quality AVIF files.
   *(Note: The user-facing page HTML body will still use AVIF for optimal performance, but head metadata will reference WebP for 100% compatibility).*

2. **Add `max-image-preview:large` directive:**
   Update the robots metadata to allow large image snippets.

3. **Align and Enrich Metadata:**
   - Update `og:image` and `twitter:image` to use `https://www.psychotherapieberger.at/Lisa-Photo-1.webp`.
   - Update `MedicalBusiness` structured schema image to use `https://www.psychotherapieberger.at/Lisa-Photo-1.webp`.
   - Add a `WebPage` JSON-LD schema referencing the primary page image via the `primaryImageOfPage` property.

---

## Specifications

### 1. HTML head metadata changes (`index.html`)

#### Robots Meta
```html
<meta name="robots" content="index, follow, max-image-preview:large">
```

#### OpenGraph & Twitter Images
```html
<meta property="og:image" content="https://www.psychotherapieberger.at/Lisa-Photo-1.webp">
<meta property="twitter:image" content="https://www.psychotherapieberger.at/Lisa-Photo-1.webp">
```

### 2. Schema.org updates (`index.html`)

#### MedicalBusiness Schema Update
```json
"image": "https://www.psychotherapieberger.at/Lisa-Photo-1.webp"
```

#### WebPage Schema Addition (New Script Tag)
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
