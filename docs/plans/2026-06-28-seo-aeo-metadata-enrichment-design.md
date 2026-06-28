# Design Document: SEO & AEO Metadata Enrichment

## Context & Purpose
To improve search engine discoverability (SEO) and optimize for AI-driven answer engines (AEO), we are enriching the structured metadata on the website. AI assistants (like Gemini, ChatGPT, Perplexity, and others) extract structured schema metadata to answer user questions accurately.

We will keep the website layout visually identical (no visible Q&A blocks) but inject highly detailed schema blocks into the HTML `<head>`.

## Approved Solution

### 1. Enriched `MedicalBusiness` Schema
Add details about the business owner (Lisa Berger), payment options, accepted currencies, services, and geographic regions served.

### 2. `FAQPage` Schema
Create an FAQ schema representing the core questions and answers that exist on the page regarding pricing, target audiences, cancellation policies, confidentiality, and training credentials.

---

## Specifications

### JSON-LD Scripts to Add/Modify in `index.html`

#### Enriched MedicalBusiness
```json
{
  "@context": "https://schema.org",
  "@type": "MedicalBusiness",
  "name": "Praxis für Psychotherapie | Lisa Berger",
  "image": "https://www.psychotherapieberger.at/Lisa-Photo-1.avif",
  "@id": "https://www.psychotherapieberger.at/",
  "url": "https://www.psychotherapieberger.at/",
  "telephone": "+43 677 631 426 87",
  "email": "info@psychotherapieberger.at",
  "priceRange": "80€ - 180€",
  "paymentAccepted": "Cash, Bank Transfer",
  "currenciesAccepted": "EUR",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "Stadtplatz 36/25",
    "addressLocality": "Vöcklabruck",
    "postalCode": "4840",
    "addressCountry": "AT"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": 48.0084,
    "longitude": 13.6559
  },
  "areaServed": [
    {
      "@type": "AdministrativeArea",
      "name": "Vöcklabruck"
    },
    {
      "@type": "AdministrativeArea",
      "name": "Oberösterreich"
    }
  ],
  "founder": {
    "@type": "Person",
    "name": "Lisa Berger",
    "jobTitle": "Psychotherapeutin",
    "knowsAbout": [
      "Psychotherapie",
      "Paartherapie",
      "Personzentrierte Psychotherapie",
      "Humanistische Psychotherapie"
    ]
  },
  "openingHoursSpecification": {
    "@type": "OpeningHoursSpecification",
    "dayOfWeek": [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday"
    ],
    "opens": "09:00",
    "closes": "18:00"
  },
  "medicalSpecialty": "Psychiatric",
  "acceptsReservations": "true"
}
```

#### FAQPage (New Script Block)
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Für wen ist das Psychotherapie-Angebot geeignet?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "In meiner Praxis arbeite ich mit Jugendlichen und Erwachsenen. Für den Beginn der Therapie ist keine ärztliche Zuweisung erforderlich."
      }
    },
    {
      "@type": "Question",
      "name": "Wie viel kostet eine Einheit Psychotherapie oder Paartherapie?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Eine Einheit Psychotherapie dauert 50 Minuten und kostet 80 €. Eine Einheit Paartherapie dauert 90 Minuten und kostet 180 €."
      }
    },
    {
      "@type": "Question",
      "name": "Bieten Sie auch Plätze zu Sozialtarifen an?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Ja. Es ist mir ein Anliegen, Psychotherapie auch Menschen zugänglich zu machen, die sich das reguläre Honorar nicht leisten können. Daher biete ich auf Anfrage eine begrenzte Anzahl an Therapieplätzen zu Sozialtarifen an."
      }
    },
    {
      "@type": "Question",
      "name": "Wie lautet die Absageregelung für Therapietermine?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Einen bereits festgelegten Termin können Sie bis zu 48 Stunden vor der geplanten Einheit kostenfrei absagen. Kurzfristige Absagen und versäumte Stunden werden in Rechnung gestellt."
      }
    },
    {
      "@type": "Question",
      "name": "Unterliegen Sie der Verschwiegenheitspflicht?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Ja. Als Psychotherapeutin bin ich gemäß §15 Psychotherapiegesetz zur absoluten Verschwiegenheit verpflichtet. Diese gilt auch vor Behörden, Krankenkassen oder Angehörigen."
      }
    },
    {
      "@type": "Question",
      "name": "Was bedeutet der Status 'Psychotherapeutin in Fachausbildung unter Lehrsupervision'?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Das bedeutet, dass ich mich im letzten Abschnitt meiner Ausbildung befinde und meine psychotherapeutische Arbeit supervidieren lasse. Ich biete meine Stunden zu einem günstigeren Tarif an, eine Rückerstattung durch gesetzliche Krankenkassen ist jedoch nicht möglich."
      }
    }
  ]
}
```
