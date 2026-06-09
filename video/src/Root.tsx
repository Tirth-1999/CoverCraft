import React from 'react';
import {Composition} from 'remotion';
import {CoverCraftDemo} from './CoverCraftDemo';

const fps = 30;
const durationInFrames = 60 * fps;

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="CoverCraftLinkedIn"
        component={CoverCraftDemo}
        durationInFrames={durationInFrames}
        fps={fps}
        width={1080}
        height={1350}
        defaultProps={{layout: 'portrait'}}
      />
      <Composition
        id="CoverCraftSquare"
        component={CoverCraftDemo}
        durationInFrames={durationInFrames}
        fps={fps}
        width={1080}
        height={1080}
        defaultProps={{layout: 'square'}}
      />
    </>
  );
};
