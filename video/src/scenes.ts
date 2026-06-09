export type Scene = {
  from: number;
  duration: number;
  type: 'video' | 'image' | 'title';
  src?: string;
  caption: string;
  kicker?: string;
  fit?: 'portrait' | 'wide';
};

export const scenes: Scene[] = [
  {
    from: 0,
    duration: 4,
    type: 'title',
    kicker: 'CoverCraft',
    caption: 'Job applications should not mean rebuilding context every time.',
  },
  {
    from: 4,
    duration: 8,
    type: 'video',
    src: 'branding/Live_Execution.mp4',
    caption: 'Start directly from the live job page.',
    fit: 'wide',
  },
  {
    from: 12,
    duration: 7,
    type: 'image',
    src: 'branding/extension-cover-letter.png',
    caption: 'Generate or save a tailored cover letter.',
    fit: 'portrait',
  },
  {
    from: 19,
    duration: 7,
    type: 'image',
    src: 'branding/extension-resume.png',
    caption: 'Tailor a resume draft from the same context.',
    fit: 'portrait',
  },
  {
    from: 26,
    duration: 6,
    type: 'image',
    src: 'branding/extension-question.png',
    caption: 'Ask follow-up questions in the same session.',
    fit: 'portrait',
  },
  {
    from: 32,
    duration: 8,
    type: 'image',
    src: 'branding/dashboard-overview.jpeg',
    caption: 'Every application becomes a reusable workspace.',
    fit: 'wide',
  },
  {
    from: 40,
    duration: 7,
    type: 'image',
    src: 'branding/dashboard-sessions.jpeg',
    caption: 'Reopen previous companies and drafts.',
    fit: 'wide',
  },
  {
    from: 47,
    duration: 5,
    type: 'image',
    src: 'branding/dashboard-profile.jpeg',
    caption: 'Keep profile context ready.',
    fit: 'wide',
  },
  {
    from: 52,
    duration: 4,
    type: 'image',
    src: 'branding/dashboard-settings.jpeg',
    caption: 'Control providers, sync, settings, and model usage.',
    fit: 'wide',
  },
  {
    from: 56,
    duration: 4,
    type: 'title',
    kicker: 'CoverCraft',
    caption: 'Faster applications from the job page.',
  },
];
