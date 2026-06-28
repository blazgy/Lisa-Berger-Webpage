# Design Document: Static Therapy Spots Info Banner

## Context & Problem
The therapist's website currently features a sliding text marquee in the hero section displaying:
`Derzeit sind keine freien Therapieplätze verfügbar.`

We want to adjust this message to be more informative:
`Zurzeit sind leider alle Therapieplätze belegt. Voraussichtlich stehen ab Oktober wieder freie Plätze zur Verfügung. Gerne können Sie sich bereits jetzt auf die Warteliste setzen lassen.`

Because this new text is significantly longer (187 characters vs 52 characters), a marquee is no longer optimal:
- It would scroll for too long, making it hard to read.
- The scrolling movement on mobile would be distracting or hard to track.

## Approved Solution
We are replacing the moving marquee with an elegant, static glassmorphic banner (`info-banner`) styled with a light sage green accent. This draws clear but gentle attention, remains perfectly readable, and scales naturally on mobile devices.

## Specifications

### 1. HTML Markup (`index.html`)
Remove the marquee container and replace it with:
```html
<!-- Info Banner -->
<div class="info-banner animate-fade-in">
    <div class="info-banner-inner">
        <i data-lucide="info" class="info-banner-icon"></i>
        <span class="info-banner-text">
            Zurzeit sind leider alle Therapieplätze belegt. Voraussichtlich stehen ab Oktober wieder freie Plätze zur Verfügung. Gerne können Sie sich bereits jetzt auf die Warteliste setzen lassen.
        </span>
    </div>
</div>
```

### 2. CSS Styling (`styles.css`)
Remove the old marquee-specific styles and add:
```css
/* INFO BANNER */
.info-banner {
    width: 100%;
    margin-bottom: 2.5rem;
    padding: 1rem 1.5rem;
    border-radius: 1rem;
    background: rgba(179, 218, 182, 0.15); /* Light Sage tint */
    border: 1px solid rgba(179, 218, 182, 0.4);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
}

.info-banner-inner {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    max-width: 900px;
    margin: 0 auto;
}

.info-banner-icon {
    color: var(--swatch--dark-text);
    flex-shrink: 0;
    width: 1.25rem;
    height: 1.25rem;
    margin-top: 0.15rem; /* Optical alignment with body text first line */
}

.info-banner-text {
    font-family: var(--font-family--body);
    font-size: var(--text-size--small);
    line-height: 1.6;
    color: var(--swatch--dark-text);
}

@media screen and (max-width: 767px) {
    .info-banner {
        padding: 0.875rem 1.25rem;
        margin-bottom: 1.75rem;
    }
    .info-banner-inner {
        gap: 0.75rem;
    }
}
```
