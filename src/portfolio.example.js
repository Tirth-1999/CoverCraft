// CoverCraft — Your Portfolio (White-Label Template)
// ────────────────────────────────────────────────────
// 1. Copy this file:  cp src/portfolio.example.js src/portfolio.js
// 2. Fill in YOUR details below.
// 3. src/portfolio.js is gitignored — your personal data will NEVER be committed.
//
// Tips:
//   • Keep highlights as specific, metric-driven bullets (numbers = better cover letters)
//   • List experiences in reverse-chronological order (most recent first)
//   • skills can be a comma-separated string or a short paragraph
//   • certifications can be an empty array [] if you have none yet

var PORTFOLIO = {
  // ── Identity ────────────────────────────────────────────────────────────────
  name:    'Your Full Name',
  phone:   '555-000-0000',
  email:   'your.email@example.com',
  website: 'yourwebsite.com',          // shown as a clickable hyperlink in the PDF

  // ── Education ───────────────────────────────────────────────────────────────
  // One string — degrees, universities, graduation years, GPA (if strong)
  education: 'B.S. Computer Science, State University (May 2024), GPA 3.8/4.0.',

  // ── Key Achievements ────────────────────────────────────────────────────────
  // Top 5–7 career highlights — used when the AI needs a strong opener
  achievements: [
    'Describe a quantified win: e.g. "Built X that did Y, resulting in Z% improvement"',
    'Another top achievement with a number',
    'Award, scholarship, or recognition',
    'Side project or open-source contribution with measurable impact'
  ],

  // ── Work Experience ─────────────────────────────────────────────────────────
  // Each entry = one job. highlights are the bullet points from that job ONLY.
  // The AI is strictly forbidden from mixing highlights across entries.
  experiences: [
    {
      company:  'Most Recent Company',
      role:     'Your Job Title',
      duration: 'Month Year – Present',
      highlights: [
        'What you built or owned, with a specific metric (e.g. "reduced X by 40%")',
        'Second bullet with a number',
        'Third bullet — optional'
      ]
    },
    {
      company:  'Previous Company',
      role:     'Your Job Title',
      duration: 'Month Year – Month Year',
      highlights: [
        'Bullet with metric',
        'Bullet with metric'
      ]
    },
    {
      company:  'Internship / Earlier Role',
      role:     'Your Job Title',
      duration: 'Month Year – Month Year',
      highlights: [
        'Bullet with metric',
        'Bullet with metric'
      ]
    }
    // Add more entries as needed — no limit
  ],

  // ── Skills ──────────────────────────────────────────────────────────────────
  // Comma-separated list or short paragraph — used to match job keywords
  skills: 'Python, SQL, JavaScript, React, Node.js, AWS, Docker. Domains: Web Development, Data Engineering, API Design.',

  // ── Certifications ──────────────────────────────────────────────────────────
  certifications: [
    'AWS Certified Solutions Architect – Associate, Jan 2024',
    'Google Professional Data Engineer, Mar 2023'
    // Remove or add as needed
  ]
};
