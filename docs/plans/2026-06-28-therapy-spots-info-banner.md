# Therapy Spots Info Banner Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the scrolling text marquee with a static, elegant, responsive notice banner.

**Architecture:** We will replace the marquee element in the HTML structure with a new info banner container containing a Lucide icon and the new message. In CSS, we will clean up the unused marquee rules and add styling for the banner, using a semi-transparent sage green background for gentle visual hierarchy.

**Tech Stack:** HTML5, Vanilla CSS3, Lucide Icons

---

### Task 1: Update HTML Markup

**Files:**
- Modify: `index.html:110-130`

**Step 1: Write target modifications**
Locate the `.marquee-container` div in [index.html](file:///Users/blazgyoha/Documents/Lisa%20Berger%20Webpage/index.html) and replace it with:
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

**Step 2: Verify HTML syntax**
Ensure that the tags are properly closed and indented.

**Step 3: Commit HTML changes**
Run:
```bash
git add index.html
git commit -m "feat: replace marquee markup with static info banner"
```

---

### Task 2: Update CSS Styles

**Files:**
- Modify: `styles.css:1620-1678`

**Step 1: Replace marquee rules with banner rules**
In [styles.css](file:///Users/blazgyoha/Documents/Lisa%20Berger%20Webpage/styles.css), remove the styles for `.marquee-container`, `.marquee-track`, `.marquee-group`, `.marquee-group span`, `@keyframes marquee-scroll`, and `@media screen and (max-width: 767px) { .marquee-track { animation-duration: 24s; } }`.

Replace them with:
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
    margin-top: 0.15rem; /* Optical alignment with first line of body text */
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

**Step 2: Commit CSS changes**
Run:
```bash
git add styles.css
git commit -m "style: remove marquee styles and add info banner styles"
```

---

### Task 3: Manual Visual Verification

**Files:**
- Verify: [index.html](file:///Users/blazgyoha/Documents/Lisa%20Berger%20Webpage/index.html) loaded in browser

**Step 1: Check localhost server**
If the local server isn't running, run it:
```bash
npx -y http-server -p 8080
```

**Step 2: Inspect styling and responsiveness**
- Open `http://localhost:8080` in the browser.
- Verify that the info banner renders correctly, with the Lucide `info` icon resolved.
- Check readability, padding, and layout on both desktop and mobile viewports.
