import React from 'react';
import {
  AbsoluteFill,
  Img,
  Sequence,
  Video,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {scenes, type Scene} from './scenes';

type Props = {
  layout: 'portrait' | 'square';
};

const fps = 30;

const styles: Record<string, React.CSSProperties> = {
  frame: {
    background: '#0b1020',
    color: '#f8fafc',
    fontFamily:
      'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    overflow: 'hidden',
  },
  glowA: {
    position: 'absolute',
    width: 760,
    height: 760,
    borderRadius: 760,
    background: 'rgba(20, 184, 166, 0.22)',
    filter: 'blur(80px)',
    left: -230,
    top: -170,
  },
  glowB: {
    position: 'absolute',
    width: 840,
    height: 840,
    borderRadius: 840,
    background: 'rgba(244, 114, 182, 0.18)',
    filter: 'blur(90px)',
    right: -330,
    bottom: -250,
  },
  grid: {
    position: 'absolute',
    inset: 0,
    backgroundImage:
      'linear-gradient(rgba(255,255,255,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.055) 1px, transparent 1px)',
    backgroundSize: '54px 54px',
    maskImage: 'linear-gradient(to bottom, rgba(0,0,0,0.7), transparent 75%)',
  },
  brand: {
    position: 'absolute',
    top: 46,
    left: 58,
    right: 58,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 26,
    fontWeight: 800,
    letterSpacing: 0,
  },
  badge: {
    border: '1px solid rgba(255,255,255,0.22)',
    borderRadius: 999,
    padding: '10px 16px',
    fontSize: 18,
    fontWeight: 700,
    color: '#d1fae5',
    background: 'rgba(15, 23, 42, 0.7)',
  },
  mediaWrap: {
    position: 'absolute',
    left: 72,
    right: 72,
    top: 168,
    bottom: 284,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  screenShell: {
    position: 'relative',
    width: '100%',
    height: '100%',
    borderRadius: 26,
    overflow: 'hidden',
    background: 'rgba(15, 23, 42, 0.76)',
    border: '1px solid rgba(255,255,255,0.16)',
    boxShadow: '0 34px 100px rgba(0,0,0,0.42)',
  },
  image: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
  },
  wideImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
  },
  captionWrap: {
    position: 'absolute',
    left: 72,
    right: 72,
    bottom: 86,
  },
  caption: {
    fontSize: 58,
    lineHeight: 1.05,
    fontWeight: 850,
    letterSpacing: 0,
    margin: 0,
    textWrap: 'balance',
  },
  subline: {
    marginTop: 22,
    width: 190,
    height: 6,
    borderRadius: 999,
    background: '#2dd4bf',
  },
  titleScene: {
    position: 'absolute',
    inset: 86,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
  },
  kicker: {
    color: '#5eead4',
    fontSize: 34,
    fontWeight: 850,
    marginBottom: 26,
  },
  title: {
    fontSize: 82,
    lineHeight: 0.98,
    fontWeight: 900,
    letterSpacing: 0,
    maxWidth: 860,
    margin: 0,
  },
};

const SceneLayer: React.FC<{scene: Scene}> = ({scene}) => {
  const frame = useCurrentFrame();
  const {fps: configFps} = useVideoConfig();
  const localFrame = frame;
  const progress = interpolate(localFrame, [0, scene.duration * fps], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const enter = spring({
    frame: Math.max(0, localFrame),
    fps: configFps,
    config: {damping: 18, stiffness: 90},
  });
  const opacity = interpolate(
    localFrame,
    [0, 12, scene.duration * fps - 12, scene.duration * fps],
    [0, 1, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const scale = 1.015 + progress * 0.055;
  const translateY = interpolate(enter, [0, 1], [26, 0]);

  if (scene.type === 'title') {
    return (
      <AbsoluteFill style={{opacity, transform: `translateY(${translateY}px)`}}>
        <div style={styles.titleScene}>
          <div style={styles.kicker}>{scene.kicker}</div>
          <h1 style={styles.title}>{scene.caption}</h1>
          <div style={styles.subline} />
        </div>
      </AbsoluteFill>
    );
  }

  const mediaStyle = scene.fit === 'portrait' ? styles.image : styles.wideImage;

  return (
    <AbsoluteFill style={{opacity}}>
      <div style={{...styles.mediaWrap, transform: `translateY(${translateY}px)`}}>
        <div style={styles.screenShell}>
          {scene.type === 'video' && scene.src ? (
            <Video
              src={staticFile(scene.src)}
              startFrom={0}
              muted
              style={{...styles.wideImage, transform: `scale(${scale})`}}
            />
          ) : null}
          {scene.type === 'image' && scene.src ? (
            <Img
              src={staticFile(scene.src)}
              style={{...mediaStyle, transform: `scale(${scale})`}}
            />
          ) : null}
        </div>
      </div>
      <div
        style={{
          ...styles.captionWrap,
          opacity: enter,
          transform: `translateY(${interpolate(enter, [0, 1], [18, 0])}px)`,
        }}
      >
        <h2 style={styles.caption}>{scene.caption}</h2>
        <div style={styles.subline} />
      </div>
    </AbsoluteFill>
  );
};

export const CoverCraftDemo: React.FC<Props> = () => {
  return (
    <AbsoluteFill style={styles.frame}>
      <div style={styles.glowA} />
      <div style={styles.glowB} />
      <div style={styles.grid} />
      <div style={styles.brand}>
        <div>CoverCraft</div>
        <div style={styles.badge}>Chrome extension</div>
      </div>
      {scenes.map((scene) => (
        <Sequence
          key={`${scene.from}-${scene.caption}`}
          from={scene.from * fps}
          durationInFrames={scene.duration * fps}
        >
          <SceneLayer scene={scene} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
