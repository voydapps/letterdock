// The Letterdock logo in the custom title bars. One PNG per display scale (drawn per size on a pixel grid,
// scripts/build-icons.mjs), so edges land on whole pixels at 125%, 150% and so on. (icon-small.svg has edges at
// fractional positions, so its rasterised edges are soft at those scales.)
// The PNG is chosen here from devicePixelRatio, not with srcset: Chromium's srcset picked the next size up at
// exactly 1.5x (a 32 px image squeezed into 24 px), which is soft again.
import { useEffect, useState } from 'react';
import p16 from '../assets/appico/appico-16.png';
import p20 from '../assets/appico/appico-20.png';
import p24 from '../assets/appico/appico-24.png';
import p28 from '../assets/appico/appico-28.png';
import p32 from '../assets/appico/appico-32.png';
import p40 from '../assets/appico/appico-40.png';
import p48 from '../assets/appico/appico-48.png';

const FRAMES: readonly [number, string][] = [
  [16, p16],
  [20, p20],
  [24, p24],
  [28, p28],
  [32, p32],
  [40, p40],
  [48, p48],
];

/** The frame for a display scale: the smallest one that has at least 16 css px * ratio device pixels. */
export function logoFor(ratio: number): string {
  const want = Math.round(16 * ratio);
  return (FRAMES.find(([px]) => px >= want) ?? FRAMES[FRAMES.length - 1])[1];
}

export function AppLogo() {
  const [ratio, setRatio] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    // Fires when the scale changes (another monitor, display settings).
    const mq = window.matchMedia(`(resolution: ${ratio}dppx)`);
    const on = () => setRatio(window.devicePixelRatio || 1);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [ratio]);
  return <img className="appico" src={logoFor(ratio)} width={16} height={16} alt="" aria-hidden="true" draggable={false} />;
}
