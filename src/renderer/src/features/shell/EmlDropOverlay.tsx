// Drop overlay of the main window (DESIGN-SPEC 3.14.2): "Drop to open this message". It shows only while the
// drag carries files, never for text or message rows (those carry no "Files" type). The drop opens the files.
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../components/Icon';
import { openDroppedFiles } from '../../lib/actions';

const carriesFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

export function EmlDropOverlay() {
  const [over, setOver] = useState(false);
  // dragenter / dragleave fire for every child element crossed, so count them.
  const depth = useRef(0);

  useEffect(() => {
    const reset = () => {
      depth.current = 0;
      setOver(false);
    };
    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setOver(true);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault(); // without this the browser would navigate to the dropped file
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0 || e.relatedTarget === null) reset();
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      reset();
      openDroppedFiles(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', reset);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', reset);
    };
  }, []);

  // The live region stays in the page, so a screen reader hears the text when it appears.
  return (
    <div className={`eml-drop ${over ? 'on' : ''}`} role="status" aria-live="polite" data-eml-drop={over ? 'on' : 'off'}>
      {over ? (
        <div className="eml-drop-box">
          <Icon name="file" size={24} />
          <span>Drop to open this message</span>
        </div>
      ) : null}
    </div>
  );
}
