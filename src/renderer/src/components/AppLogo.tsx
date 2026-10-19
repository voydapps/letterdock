// The Letterdock logo in the custom title bars. One PNG per display scale (drawn per size on a pixel grid,
// scripts/build-icons.mjs), so it stays sharp at 125%, 150% and so on. An SVG scaled by the browser blurs.
import p16 from '../assets/appico/appico-16.png';
import p20 from '../assets/appico/appico-20.png';
import p24 from '../assets/appico/appico-24.png';
import p28 from '../assets/appico/appico-28.png';
import p32 from '../assets/appico/appico-32.png';
import p40 from '../assets/appico/appico-40.png';
import p48 from '../assets/appico/appico-48.png';

const SRC_SET = `${p16} 1x, ${p20} 1.25x, ${p24} 1.5x, ${p28} 1.75x, ${p32} 2x, ${p40} 2.5x, ${p48} 3x`;

export function AppLogo() {
  return <img className="appico" src={p16} srcSet={SRC_SET} width={16} height={16} alt="" aria-hidden="true" draggable={false} />;
}
