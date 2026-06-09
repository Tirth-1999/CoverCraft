# CoverCraft Remotion Demo

This folder renders the CoverCraft LinkedIn demo video with Remotion.

## Commands

```bash
npm install
npm run dev
npm run render
npm run render:square
```

## Outputs

- `out/covercraft-linkedin-demo.mp4` - 1080 x 1350, recommended for LinkedIn feed
- `out/covercraft-square-demo.mp4` - 1080 x 1080, square fallback

## Editing

- Scene timing and captions live in `src/scenes.ts`.
- Layout and animation live in `src/CoverCraftDemo.tsx`.
- Source media is copied from `../site/branding/` by `npm run sync-assets`.

Generated videos and copied media are ignored by Git so the repo does not duplicate large assets.

Background music and voiceover are optional editing additions and are not required to build the checked-in compositions.
